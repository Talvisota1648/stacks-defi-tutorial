import csv
import hashlib
import os
import shutil
import signal
import subprocess
import threading
import time
import uuid
from sqlalchemy import select,func
from .db import init_db,Session,transaction,Source,Job,DATA,heartbeat

stop=threading.Event()
def queue_clip(source_id,path,captured_at,key):
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    with transaction() as s:
        if s.scalar(select(Job).where(Job.source_id==source_id,Job.ingest_key==key)):return
        if s.scalar(select(func.count()).select_from(Job).where(Job.status.in_(['queued','processing'])))>=int(os.getenv('OSC_MAX_QUEUE','300')):raise RuntimeError('backlog')
        s.add(Job(id=str(uuid.uuid4()),source_id=source_id,path=str(path.relative_to(DATA)),sha256=digest,ingest_key=key,captured_at=captured_at))
        row=s.get(Source,source_id);row.last_frame=time.time();row.status='online';row.error=''


def read_segments(path,offset):
    rows=[]
    with path.open('rb') as file:
        file.seek(offset)
        while line:=file.readline():
            if not line.endswith(b'\n'):break
            offset=file.tell()
            entry=next(csv.reader([line.decode('utf-8')]))
            if len(entry)==3:rows.append(entry)
    return rows,offset

def capture(source,owner):
    url=os.getenv(source.source_env,'')
    if not url.startswith(('rtsp://','rtsps://')):raise RuntimeError('source_missing')
    folder=DATA/'captures'/source.id/str(uuid.uuid4());folder.mkdir(parents=True,exist_ok=True)
    listing=folder/'segments.csv';began=time.time();processed=set();offset=0;last_segment=time.monotonic()
    # Never shell-interpolate addresses. RTSP credentials stay in server env, not API/database/logs.
    command=['ffmpeg','-nostdin','-loglevel','error','-rtsp_transport','tcp','-timeout','8000000','-i',url,'-map','0:v:0','-an','-c:v','copy','-f','segment','-segment_time','5','-reset_timestamps','1','-segment_list',str(listing),'-segment_list_type','csv',str(folder/'%06d.mp4')]
    process=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        while not stop.wait(1):
            with transaction() as s:
                row=s.get(Source,source.id)
                if not row.enabled or row.collector_owner!=owner:return
                row.collector_lease=time.time()+30
            if listing.exists():
                entries,offset=read_segments(listing,offset)
                for entry in entries:
                    if len(entry)!=3 or entry[0] in processed:continue
                    path=(folder/PathName(entry[0])).resolve()
                    if not path.is_relative_to(folder) or not path.exists():continue
                    queue_clip(source.id,path,began+float(entry[1]),f'{folder.name}:{path.name}');processed.add(entry[0]);last_segment=time.monotonic()
            if time.monotonic()-last_segment>30:raise RuntimeError('no_frames')
            if process.poll() is not None:raise RuntimeError(f'ffmpeg_exit_{process.returncode}')
            if shutil.disk_usage(DATA).free<int(os.getenv('OSC_MIN_FREE_MB','512'))*1024**2:raise RuntimeError('disk_low')
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        # Unqueued segments are not evidence and can be removed after an interrupted connection.
        queued_names={PathName(p) for p in processed}
        for path in folder.glob('*.mp4'):
            if path.name not in queued_names:path.unlink(missing_ok=True)
        listing.unlink(missing_ok=True)

def PathName(value):return value.replace('\\','/').split('/')[-1]
def run_source(source_id,owner):
    try:
        with Session() as s:source=s.get(Source,source_id)
        capture(source,owner)
    except Exception as error:
        code=str(error) if str(error) in ('source_missing','backlog','disk_low','no_frames') or str(error).startswith('ffmpeg_exit_') else 'capture_error'
        with transaction() as s:
            row=s.get(Source,source_id)
            if row.collector_owner==owner:row.status='error';row.error=f'Ошибка {code}: проверьте RTSP-адрес, доступность камеры, очередь и диск.'
    finally:
        with transaction() as s:
            row=s.get(Source,source_id)
            if row.collector_owner==owner:row.collector_lease=0;row.collector_owner=''

def main():
    init_db();owner='collector-'+str(uuid.uuid4());threads={};retry={}
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stop.set())
    while not stop.wait(1):
        heartbeat(owner,'collector',{'status':'ready','active_streams':sum(t.is_alive() for t in threads.values())})
        with transaction() as s:
            sources=s.scalars(select(Source).where(Source.enabled==True,Source.kind=='rtsp',Source.collector_lease<time.time())).all()
            for source in sources:
                if (source.id in threads and threads[source.id].is_alive()) or time.time()<retry.get(source.id,0):continue
                source.collector_owner=owner;source.collector_lease=time.time()+30;source.status='connecting';retry[source.id]=time.time()+15
                t=threading.Thread(target=run_source,args=(source.id,owner),daemon=True);threads[source.id]=t;t.start()
    for t in threads.values():t.join(timeout=8)
if __name__=='__main__':main()
