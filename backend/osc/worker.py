import hashlib
import os
import signal
import threading
import time
import uuid
import cv2
from sqlalchemy import select
from .db import init_db,transaction,Session,Source,Job,Incident,EvidenceLink,ManualAnalysis,JobAnalysis,SourceArchive,CameraSceneState,DATA,path_for,heartbeat
from .detector import Detector,MODEL_SHA256
from .rules import evaluate
from .gallery import save_frame
from .manual import claim_manual, process_manual
from .camera_scene import analyse_camera
from .scene_policy import CATALOG

LEASE=120

def claim(owner):
    now=time.time()
    with transaction() as s:
        for expired in s.scalars(select(Job).where(Job.status=='processing',Job.lease<now,Job.attempts>=3)):
            expired.status='failed';expired.error='Рабочий процесс прерван после трёх попыток';expired.lease=0
        rows=s.execute(select(Job,Source).join(Source,Job.source_id==Source.id).where(Source.enabled==True,~select(SourceArchive.source_id).where(SourceArchive.source_id==Source.id).exists(),Source.worker_lease<now,((Job.status=='queued')|((Job.status=='processing')&(Job.lease<now))),Job.attempts<3).order_by(Job.created).limit(1)).first()
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
    report_frames=[];report_files=[];peaks={};observations={};analysed=0;next_report=0.;report_interval=max(1/source.sample_fps,count/fps/12)
    report_folder=DATA/'job_results'/job.id;report_folder.mkdir(parents=True,exist_ok=True)
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
            analysed+=1
            counts={}
            for d in detections:counts[d['label']]=counts.get(d['label'],0)+1
            for label,n in counts.items():peaks[label]=max(peaks.get(label,0),n);observations[label]=observations.get(label,0)+n
            if offset+0.0001>=next_report and len(report_frames)<12:
                next_report=offset+report_interval
                h,w=frame.shape[:2];annotated=frame.copy()
                for d in detections:
                    x1,y1,x2,y2=d['bbox'];cv2.rectangle(annotated,(int(x1*w),int(y1*h)),(int(x2*w),int(y2*h)),(60,160,240),max(1,w//500))
                    cv2.putText(annotated,f"{d['label']} {d['score']:.2f}",(int(x1*w),max(16,int(y1*h)-8)),cv2.FONT_HERSHEY_SIMPLEX,.6,(60,160,240),2)
                scale=min(1,1280/max(w,h));annotated=cv2.resize(annotated,(max(1,round(w*scale)),max(1,round(h*scale))))
                image_id=f'f{len(report_frames)}';report_path=report_folder/f'{image_id}.jpg'
                if not cv2.imwrite(str(report_path),annotated):raise RuntimeError('Cannot save analysis result')
                report_files.append(report_path)
                report_frames.append({'id':image_id,'offset':round(offset,3),'captured_at':job.captured_at+offset,'detections':detections,'width':annotated.shape[1],'height':annotated.shape[0],'path':str(report_path.relative_to(DATA)),'sha256':hashlib.sha256(report_path.read_bytes()).hexdigest()})
            save_frame(source.id,frame,job.captured_at+offset)
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
        scene_report,candidates=analyse_camera(job,source,report_frames,owner)
        for observation,view in candidates:
            event_id=str(uuid.uuid4());folder=DATA/'frames';folder.mkdir(exist_ok=True);frame_path=folder/f'{event_id}.jpg'
            image=cv2.imread(str(path_for(view['path'])));h,w=image.shape[:2]
            box=observation.get('bbox')
            if box:
                x1,y1,x2,y2=box;cv2.rectangle(image,(int(x1*w),int(y1*h)),(int(x2*w),int(y2*h)),(40,40,235),max(2,w//400))
                cv2.putText(image,'SCENE SIGNAL: '+observation['category'],(int(x1*w),max(20,int(y1*h)-8)),cv2.FONT_HERSHEY_SIMPLEX,.55,(40,40,235),2)
            if not cv2.imwrite(str(frame_path),image):raise RuntimeError('Cannot save scene evidence')
            events.append((event_id,{'rule_id':'scene-'+observation['category'],'track_id':str(uuid.uuid4()),'category':observation['category'],'dwell_seconds':0,'scene':observation,'detection':{'bbox':box,'label':CATALOG[observation['category']],'score':None}},frame_path,view['offset']))

        for view in report_frames:
            alerts=[o for o in scene_report.get('observations',[]) if o.get('camera_frame_id')==view['id'] and o['suspected_violation'] and o.get('bbox')]
            if not alerts:continue
            image=cv2.imread(str(path_for(view['path'])));h,w=image.shape[:2]
            for o in alerts:
                x1,y1,x2,y2=o['bbox'];left,top=int(x1*w),int(y1*h)
                cv2.rectangle(image,(left,top),(int(x2*w),int(y2*h)),(40,40,235),max(2,w//400))
                cv2.putText(image,'SCENE SIGNAL: '+o['category'],(left,max(20,top-8)),cv2.FONT_HERSHEY_SIMPLEX,.55,(40,40,235),2)
            if not cv2.imwrite(str(path_for(view['path'])),image):raise RuntimeError('Cannot annotate report frame')
            view['sha256']=hashlib.sha256(path_for(view['path']).read_bytes()).hexdigest()
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
                if event.get('scene'):
                    evidence.update(analysis_kind='scene',model=scene_report['model'],model_sha256=None,severity=event['scene']['severity'])
                    description=event['scene']['description']+' Предварительный сигнал ИИ. Требуется проверка специалистом.'
                s.add(Incident(id=event_id,source_id=source.id,job_id=job.id,rule_id=event['rule_id'],track_id=event['track_id'],category=event['category'],description=description,detected_at=job.captured_at+offset,evidence=evidence,location=job.location or {'latitude':source.latitude,'longitude':source.longitude,'origin':'source_configuration'}))
                s.flush()
                for c in context:s.add(EvidenceLink(incident_id=event_id,job_id=c.id))
            report={'completed_at':time.time(),'model':'YOLOX Nano','sample_fps':source.sample_fps,'analysed_frames':analysed,'duration':count/fps,'peak_objects':peaks,'object_observations':observations,'frames':report_frames,'signals':len(events),'scene':{k:v for k,v in scene_report.items() if k!='cooldown_updates'},'note':'Количество наблюдений суммируется по кадрам, это не число уникальных людей или машин. Наличие объекта само по себе не является нарушением.'}
            saved=s.get(JobAnalysis,job.id)
            if saved:saved.result=report
            else:s.add(JobAnalysis(job_id=job.id,result=report))
            if 'cooldown_updates' in scene_report:s.get(CameraSceneState,source.id).recent=scene_report['cooldown_updates']
            row.status='done';row.lease=0;row.error=scene_report.get('error','');src.rule_state=state if src.sample_fps==source.sample_fps else {};src.worker_lease=0;src.worker_owner=''
    except BaseException:
        for _,_,p,_ in events:p.unlink(missing_ok=True)
        for p in report_files:p.unlink(missing_ok=True)
        raise
    finally:cap.release()

def fail(job,owner):
    with transaction() as s:
        row=s.get(Job,job.id);source=s.get(Source,job.source_id)
        if row.owner==owner:
            row.status='cancelled' if s.get(SourceArchive,source.id) else 'failed';row.error='Не удалось обработать клип: проверьте формат, длительность до 120 с, целостность и состояние модели';row.lease=0
        if source.worker_owner==owner:source.worker_owner='';source.worker_lease=0

def cleanup():
    from .storage import cleanup as clean_storage
    return clean_storage()

def main():
    init_db();owner='worker-'+str(uuid.uuid4());stop=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stop.set())
    try:detector=Detector()
    except Exception:
        detector=None
        heartbeat(owner,'worker',{'status':'model_error','error':'Model missing, checksum invalid or inference provider unavailable'})
    last_cleanup=0;manual_turn=True
    while not stop.is_set():
        details={'model':'YOLOX Nano','provider':detector.provider,'status':'ready'} if detector else {'status':'model_error','error':'Локальная модель недоступна. OpenRouter может работать независимо.'}
        heartbeat(owner,'worker',details)
        manual=claim_manual(owner,detector is not None) if manual_turn or not detector else None
        task=claim(owner) if detector and not manual else None
        if not manual and not task:manual=claim_manual(owner,detector is not None)
        if manual:
            pulse_stop=threading.Event()
            def pulse():
                while not pulse_stop.wait(10):
                    with transaction() as s:
                        row=s.get(ManualAnalysis,manual.id)
                        if row.owner!=owner or row.status!='processing':return
                        row.lease=time.time()+180
                    heartbeat(owner,'worker',{**details,'analysis_provider':manual.provider})
            thread=threading.Thread(target=pulse,daemon=True);thread.start()
            try:process_manual(manual,detector,owner)
            finally:pulse_stop.set();thread.join(timeout=2)
            manual_turn=False
        elif task:
            try:process(*task,detector,owner)
            except Exception:fail(task[0],owner)
            manual_turn=True
        else:stop.wait(1)
        if time.time()-last_cleanup>60:
            try:cleanup()
            except Exception:print('Storage cleanup failed; will retry',flush=True)
            last_cleanup=time.time()
if __name__=='__main__':main()
