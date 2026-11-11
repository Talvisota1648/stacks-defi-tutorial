import time
import threading
from .db import transaction, CameraSceneState, Source, Job
from .scene_policy import policy
from .manual import call_openrouter


def analyse_camera(job,source,frames,owner):
    config=policy()
    if not config['camera_enabled']:return {'status':'disabled','observations':[]},[]
    now=time.time()
    with transaction() as s:
        state=s.get(CameraSceneState,source.id)
        if state and state.next_attempt>now:return {'status':'interval','next_attempt':state.next_attempt,'observations':[]},[]
        if not state:state=CameraSceneState(source_id=source.id);s.add(state)
        state.next_attempt=now+config['camera_interval']
        row=s.get(Job,job.id);src=s.get(Source,source.id)
        if row.owner!=owner or not src.enabled:raise RuntimeError('Source changed')
        row.lease=now+180;src.worker_lease=row.lease
    selected=[frames[round(i*(len(frames)-1)/max(1,min(len(frames),config['camera_frames'])-1))] for i in range(min(len(frames),config['camera_frames']))]
    items=[{**f,'id':f's{i}','timestamp':f['offset']} for i,f in enumerate(selected)]
    stop=threading.Event()
    def pulse():
        while not stop.wait(10):
            with transaction() as s:
                row=s.get(Job,job.id);src=s.get(Source,source.id)
                if row.owner!=owner or not src.enabled:return
                row.lease=time.time()+180;src.worker_lease=row.lease
    thread=threading.Thread(target=pulse,daemon=True);thread.start()
    try:
        report=call_openrouter(items,config,backend=config['provider'])
        report.update(status='completed',analysed_frames=len(items))
        candidates=[]
        with transaction() as s:
            state=s.get(CameraSceneState,source.id);recent={k:v for k,v in state.recent.items() if now-v<300}
            for o in report['observations']:
                frame=selected[int(o['frame_id'][1:])]
                o.update(camera_frame_id=frame['id'],offset=frame['offset'])
                if not o['suspected_violation']:continue
                box=o.get('bbox');signature=o['category']+(':'+str([round((box[0]+box[2])*5),round((box[1]+box[3])*5)]) if box else '')
                if signature in recent:continue
                recent[signature]=now;candidates.append((o,frame))
            # Store cooldown only after evidence is committed by the worker.
        report['cooldown_updates']=recent
        return report,candidates
    except Exception:
        return {'status':'failed','error':'Анализ сцены не выполнен. Проверьте vision-модель, ключ, баланс и доступность сервера. Отсутствие сигналов не означает отсутствие опасности.','observations':[]},[]
    finally:stop.set();thread.join(timeout=2)
