"""Bounded retention and pressure cleanup; incident evidence and active jobs are protected."""
import argparse
import json
import os
import shutil
import time
from pathlib import Path
from sqlalchemy import select, func
if __name__=='__main__':
    from .run import load_env
    load_env()
from .db import DATA, Session, transaction, Source, Job, Incident, EvidenceLink, JobAnalysis, ManualAnalysis, CameraFrame, path_for

MB=1024**2

def limits():
    minimum=int(os.getenv('OSC_MIN_FREE_MB','512'))*MB
    return minimum,max(minimum+256*MB,int(os.getenv('OSC_DISK_TARGET_MB','1536'))*MB)

def status():
    usage=shutil.disk_usage(DATA);minimum,target=limits()
    return {'total_mb':usage.total//MB,'free_mb':usage.free//MB,'used_mb':usage.used//MB,'low':usage.free<minimum,'minimum_free_mb':minimum//MB,'target_free_mb':target//MB,'camera_retention_hours':float(os.getenv('OSC_UNEVENTFUL_RETENTION_HOURS','1')),'manual_retention_hours':float(os.getenv('OSC_MANUAL_RETENTION_HOURS','168'))}

def unlink(path):
    try:
        size=path.stat().st_size
        path.unlink(missing_ok=True)
        parent=path.parent
        while parent!=DATA and parent.is_relative_to(DATA):
            try:parent.rmdir()
            except OSError:break
            parent=parent.parent
        return size
    except FileNotFoundError:return 0


def context_ranges(s):
    windows={src.id:max([300]+[float(r.get('dwell_seconds',0))+30 for r in src.rules]) for src in s.scalars(select(Source))}
    spans={source:(start-windows.get(source,300),end+120) for source,start,end in s.execute(select(Job.source_id,func.min(Job.captured_at),func.max(Job.captured_at)).where(Job.status.in_(['queued','processing'])).group_by(Job.source_id))}
    return spans,windows


def manual_has_signals(row):
    observations=row.result.get('observations',[]) if isinstance(row.result,dict) else None
    # Unknown historical formats are kept rather than risking evidence loss.
    return not isinstance(observations,list) or any(not isinstance(o,dict) or o.get('suspected_violation') for o in observations)


def cleanup(emergency=False, max_items=5000):
    now=time.time();minimum,target=limits();free_before=shutil.disk_usage(DATA).free
    pressure=emergency or free_before<minimum
    camera_cutoff=now-float(os.getenv('OSC_UNEVENTFUL_RETENTION_HOURS','1'))*3600
    manual_cutoff=now-float(os.getenv('OSC_MANUAL_RETENTION_HOURS','168'))*3600
    result={'jobs':0,'analyses':0,'orphans':0,'freed_bytes':0}
    # Age retention first, then oldest recent material only when space is low.
    for by_pressure in (False,True) if pressure else (False,):
        if by_pressure and shutil.disk_usage(DATA).free>=target:break
        cursor=None
        while result['jobs']+result['analyses']<max_items:
            with transaction() as s:
                spans,windows=context_ranges(s)
                query=select(Job).where(Job.status.in_(['done','failed','cancelled']),~select(Incident.id).where(Incident.job_id==Job.id).exists(),~select(EvidenceLink.incident_id).where(EvidenceLink.job_id==Job.id).exists())
                if not by_pressure:query=query.where(Job.created<camera_cutoff)
                if cursor:query=query.where((Job.created>cursor[0])|((Job.created==cursor[0])&(Job.id>cursor[1])))
                rows=list(s.scalars(query.order_by(Job.created,Job.id).limit(100)))
                for job in rows:
                    cursor=(job.created,job.id)
                    # Preserve recent context and context needed by queued/processing jobs.
                    if job.created>now-windows.get(job.source_id,300):continue
                    span=spans.get(job.source_id)
                    if span and span[0]<=job.captured_at<=span[1]:continue
                    if by_pressure and shutil.disk_usage(DATA).free>=target:break
                    report=s.get(JobAnalysis,job.id)
                    if report and report.result.get('completed_at',0)>now-300:continue
                    result['freed_bytes']+=unlink(path_for(job.path))
                    if report:
                        for frame in report.result.get('frames',[]):result['freed_bytes']+=unlink(path_for(frame['path']))
                        s.delete(report)
                    job.status='purged';job.lease=0;result['jobs']+=1
                    if result['jobs']+result['analyses']>=max_items:break
            if not rows or (by_pressure and shutil.disk_usage(DATA).free>=target):break
        cursor=None
        while result['jobs']+result['analyses']<max_items:
            with transaction() as s:
                query=select(ManualAnalysis).where(ManualAnalysis.status.in_(['done','failed']),ManualAnalysis.created<now-300,((ManualAnalysis.finished==None)|(ManualAnalysis.finished<now-300)))
                if not by_pressure:query=query.where(ManualAnalysis.created<manual_cutoff)
                if cursor:query=query.where((ManualAnalysis.created>cursor[0])|((ManualAnalysis.created==cursor[0])&(ManualAnalysis.id>cursor[1])))
                rows=list(s.scalars(query.order_by(ManualAnalysis.created,ManualAnalysis.id).limit(100)))
                for row in rows:
                    cursor=(row.created,row.id)
                    if manual_has_signals(row):continue
                    if by_pressure and shutil.disk_usage(DATA).free>=target:break
                    result['freed_bytes']+=unlink(path_for(row.path))
                    folder=DATA/'analyses'/row.id
                    for path in folder.glob('*.jpg'):result['freed_bytes']+=unlink(path)
                    row.status='purged';row.error='Исходный файл и кадры удалены автоматической очисткой. Загрузите файл повторно для нового анализа.'
                    row.result={**row.result,'frames':[]} if isinstance(row.result,dict) else {}
                    result['analyses']+=1
                    if result['jobs']+result['analyses']>=max_items:break
            if not rows or (by_pressure and shutil.disk_usage(DATA).free>=target):break
    result['freed_bytes']+=prune_orphans(result)
    result['freed_bytes']+=trim_logs()
    result.update(freed_mb=round(result['freed_bytes']/MB,1),free_mb=shutil.disk_usage(DATA).free//MB,low=shutil.disk_usage(DATA).free<minimum)
    return result


def collect_paths(value,paths):
    if isinstance(value,dict):
        for key,item in value.items():
            if key=='path' and isinstance(item,str):paths.add(str(path_for(item)))
            else:collect_paths(item,paths)
    elif isinstance(value,list):
        for item in value:collect_paths(item,paths)


def prune_orphans(result):
    """Remove only known generated files, old enough and absent from all manifests."""
    now=time.time();refs=set();active_folders=[]
    with Session() as s:
        for path in s.scalars(select(Job.path).where(Job.status!='purged')):refs.add(str(path_for(path)))
        processing=list(s.scalars(select(Job.id).where(Job.status=='processing')))
        active_folders.extend(DATA/'job_results'/job for job in processing)
        if processing:active_folders.append(DATA/'frames')
        for evidence in s.scalars(select(Incident.evidence).execution_options(yield_per=200)):
            collect_paths({key:evidence.get(key) for key in ('frame','clip','context_clips')},refs)
        for report in s.scalars(select(JobAnalysis.result).execution_options(yield_per=200)):collect_paths(report.get('frames',[]),refs)
        for path in s.scalars(select(CameraFrame.path)):refs.add(str(path_for(path)))
        for row in s.scalars(select(ManualAnalysis).where(ManualAnalysis.status!='purged').execution_options(yield_per=200)):
            refs.add(str(path_for(row.path)));collect_paths(row.result.get('frames',[]) if isinstance(row.result,dict) else [],refs)
            if row.status in ('queued','processing') or manual_has_signals(row):active_folders.append(DATA/'analyses'/row.id)
    freed=0;visited=0
    for name in ('captures','uploads','manual_uploads','job_results','analyses','frames','camera_frames','previews'):
        folder=DATA/name
        for path in folder.rglob('*'):
            visited+=1
            if visited>50000:return freed
            if path.is_symlink():continue
            if path.is_dir():
                try:
                    if now-path.stat().st_mtime>3600:path.rmdir()
                except OSError:pass
                continue
            if path.name=='.active':
                try:
                    if now-path.stat().st_mtime>3600:freed+=unlink(path)
                except FileNotFoundError:pass
                continue
            if not path.is_file() or path.suffix not in ('.mp4','.jpg','.part','.csv'):continue
            if str(path.resolve()) in refs or any(path.is_relative_to(p) for p in active_folders):continue
            try:
                if now-path.stat().st_mtime<3600:continue
                marker=path.parent/'.active'
                if name=='captures' and marker.exists() and now-marker.stat().st_mtime<90:continue
                freed+=unlink(path);result['orphans']+=1
            except FileNotFoundError:continue
    return freed


def trim_logs():
    # Copy-truncate preserves append-mode file descriptors of running services.
    freed=0;folder=Path(__file__).resolve().parents[2]/'logs'
    for name in ('api','worker','collector','web'):
        path=folder/f'{name}.log'
        if path.is_symlink() or not path.exists() or path.stat().st_size<10*MB:continue
        with path.open('r+b') as log:
            log.seek(-MB,2);tail=log.read();size=log.tell();log.seek(0);log.write(tail);log.truncate()
        freed+=max(0,size-len(tail))
    return freed


def main():
    from .db import init_db
    init_db()
    parser=argparse.ArgumentParser();parser.add_argument('--emergency',action='store_true');args=parser.parse_args()
    result=cleanup(emergency=args.emergency)
    print(json.dumps(result,ensure_ascii=False))
    if result['low']:
        raise SystemExit('Недостаточно места после безопасной очистки. Активные задания и материалы событий не удалены. Освободите место в архиве или увеличьте диск перед сборкой.')

if __name__=='__main__':main()
