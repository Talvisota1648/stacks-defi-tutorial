import hashlib
import os
import signal
import threading
import time
import uuid
import cv2
from sqlalchemy import select
from .db import init_db,transaction,Session,Source,Job,Incident,EvidenceLink,DATA,path_for,heartbeat
from .detector import Detector,MODEL_SHA256
from .rules import evaluate

LEASE=120

def claim(owner):
    now=time.time()
    with transaction() as s:
        for expired in s.scalars(select(Job).where(Job.status=='processing',Job.lease<now,Job.attempts>=3)):
            expired.status='failed';expired.error='Рабочий процесс прерван после трёх попыток';expired.lease=0
        rows=s.execute(select(Job,Source).join(Source,Job.source_id==Source.id).where(Source.enabled==True,Source.worker_lease<now,((Job.status=='queued')|((Job.status=='processing')&(Job.lease<now))),Job.attempts<3).order_by(Job.created).limit(1)).first()
        if not rows:return None
        job,source=rows;job.status='processing';job.attempts+=1;job.owner=owner;job.lease=now+LEASE
        source.worker_owner=owner;source.worker_lease=now+LEASE
        s.flush();return job,source

def process(job,source,detector,owner):
    path=path_for(job.path)
    if hashlib.sha256(path.read_bytes()).hexdigest()!=job.sha256:raise RuntimeError('Clip checksum mismatch')
    cap=cv2.VideoCapture(str(path));fps=cap.get(cv2.CAP_PROP_FPS);count=cap.get(cv2.CAP_PROP_FRAME_COUNT)
    if not cap.isOpened() or not 0<fps<=240 or not 0<count/fps<=120:
        cap.release();raise RuntimeError('Unreadable video or duration exceeds 120 seconds')
    state=source.rule_state if source.kind=='rtsp' else {};events=[];index=0;next_sample=0.;last_renew=time.monotonic()
    try:
        while cap.grab():
            offset=index/fps;index+=1
            if offset+0.0001<next_sample:continue
            next_sample=offset+1/source.sample_fps
            ok,frame=cap.retrieve()
            if not ok:continue
            preview_folder=DATA/'previews';preview_folder.mkdir(exist_ok=True)
            preview_temp=preview_folder/f'{source.id}-{owner}.jpg'
            if cv2.imwrite(str(preview_temp),frame):preview_temp.replace(preview_folder/f'{source.id}.jpg')
            detections=detector.detect(frame)
            state,found=evaluate(source.rules,state,detections,job.captured_at+offset,max(3,2.5/source.sample_fps))
            for event in found:
                event_id=str(uuid.uuid4());folder=DATA/'frames';folder.mkdir(exist_ok=True)
                frame_path=folder/f'{event_id}.jpg'
                if not cv2.imwrite(str(frame_path),frame):raise RuntimeError('Cannot write evidence frame')
                events.append((event_id,event,frame_path,offset))
            if time.monotonic()-last_renew>10:
                with transaction() as s:
                    row=s.get(Job,job.id);src=s.get(Source,source.id)
                    if row.owner!=owner or src.worker_owner!=owner or not src.enabled or src.rules!=source.rules:raise RuntimeError('Lease lost or source configuration changed')
                    row.lease=time.time()+LEASE;src.worker_lease=row.lease
                heartbeat(owner,'worker',{'model':'YOLOX Nano','provider':detector.provider,'status':'processing'});last_renew=time.monotonic()
        if not index:raise RuntimeError('No video frames decoded')
        with transaction() as s:
            row=s.get(Job,job.id);src=s.get(Source,source.id)
            if row.owner!=owner or src.worker_owner!=owner or not src.enabled or src.rules!=source.rules:raise RuntimeError('Lease lost or source configuration changed')
            for event_id,event,frame_path,offset in events:
                if s.scalar(select(Incident).where(Incident.job_id==job.id,Incident.rule_id==event['rule_id'],Incident.track_id==event['track_id'])):continue
                start=job.captured_at+offset-event['dwell_seconds']
                context=s.scalars(select(Job).where(Job.source_id==source.id,Job.captured_at>=start-10,Job.captured_at<=job.captured_at+offset).order_by(Job.captured_at).limit(750)).all()
                context=[c for c in context if c.id!=job.id and path_for(c.path).is_file()]
                context_items=[{'job_id':c.id,'path':c.path,'sha256':c.sha256,'captured_at':c.captured_at} for c in context]
                evidence={'frame':{'path':str(frame_path.relative_to(DATA)),'sha256':hashlib.sha256(frame_path.read_bytes()).hexdigest()},'clip':{'path':job.path,'sha256':job.sha256},'frame_offset':offset,'bbox':event['detection']['bbox'],'detector_score':event['detection']['score'],'label':event['detection']['label'],'model':'YOLOX Nano','model_sha256':MODEL_SHA256,'dwell_seconds':event['dwell_seconds'],'timing':'server_ingest_or_uploader_time','context_clips':context_items}
                description=('Автомобиль длительно находится в заданной ограниченной зоне.' if event['category']=='vehicle_dwell' else 'Человек присутствует в заданной ограниченной зоне.')+' Предварительный сигнал: проверьте разметку зоны, правила участка и обстоятельства. Квалификация нарушения не установлена.'
                s.add(Incident(id=event_id,source_id=source.id,job_id=job.id,rule_id=event['rule_id'],track_id=event['track_id'],category=event['category'],description=description,detected_at=job.captured_at+offset,evidence=evidence,location=job.location or {'latitude':source.latitude,'longitude':source.longitude,'origin':'source_configuration'}))
                s.flush()
                for c in context:s.add(EvidenceLink(incident_id=event_id,job_id=c.id))
            row.status='done';row.lease=0;row.error='';src.rule_state=state;src.worker_lease=0;src.worker_owner=''
    except BaseException:
        for _,_,p,_ in events:p.unlink(missing_ok=True)
        raise
    finally:cap.release()

def fail(job,owner):
    with transaction() as s:
        row=s.get(Job,job.id);source=s.get(Source,job.source_id)
        if row.owner==owner:
            row.status='failed';row.error='Не удалось обработать клип: проверьте формат, длительность до 120 с, целостность и состояние модели';row.lease=0
        if source.worker_owner==owner:source.worker_owner='';source.worker_lease=0

def cleanup():
    cutoff=time.time()-float(os.getenv('OSC_UNEVENTFUL_RETENTION_HOURS','24'))*3600
    with transaction() as s:
        rows=s.scalars(select(Job).where(Job.status=='done',Job.created<cutoff,~select(Incident.id).where(Incident.job_id==Job.id).exists(),~select(EvidenceLink.incident_id).where(EvidenceLink.job_id==Job.id).exists()).limit(100)).all()
        for job in rows:path_for(job.path).unlink(missing_ok=True);job.status='purged'

def main():
    init_db();owner='worker-'+str(uuid.uuid4());stop=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stop.set())
    try:detector=Detector()
    except Exception:
        heartbeat(owner,'worker',{'status':'model_error','error':'Model missing, checksum invalid or inference provider unavailable'});raise
    last_cleanup=0
    while not stop.is_set():
        heartbeat(owner,'worker',{'model':'YOLOX Nano','provider':detector.provider,'status':'ready'})
        task=claim(owner)
        if task:
            try:process(*task,detector,owner)
            except Exception:fail(task[0],owner)
        else:stop.wait(1)
        if time.time()-last_cleanup>60:cleanup();last_cleanup=time.time()
if __name__=='__main__':main()
