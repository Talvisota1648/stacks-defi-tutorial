import os
import time
from collections import namedtuple
from osc import db,storage


def create_job(s,name,status='done',created=None,captured=None):
    now=time.time();path=db.DATA/'captures'/name/'clip.mp4';path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'12345678')
    row=db.Job(id=name,source_id='source',path=str(path.relative_to(db.DATA)),sha256='0'*64,ingest_key=name,status=status,created=created or now-600,captured_at=captured or now-600)
    s.add(row);s.flush();return row,path


def test_pressure_cleans_recent_processed_and_failed_but_protects_evidence_and_active_jobs(monkeypatch):
    now=time.time();paths={}
    with db.transaction() as s:
        s.add(db.Source(id='source',name='camera',kind='rtsp',rules=[]));s.flush()
        for name,status,created,captured in [('done','done',now-700,now-700),('failed','failed',now-690,now-690),('cancelled','cancelled',now-680,now-680),('recent','done',now-2,now-2),('queued','queued',now-10,now-10),('processing','processing',now-10,now-10),('context','done',now-800,now-800),('pending','done',now-900,now-900),('approved','done',now-900,now-900),('rejected','done',now-900,now-900),('needed-context','done',now-500,now-200)]:
            row,path=create_job(s,name,status,created,captured);paths[name]=path
        for state in ('pending','approved','rejected'):
            s.add(db.Incident(id=state,source_id='source',job_id=state,rule_id='r',track_id='t',category='x',description='x',detected_at=1,evidence={},status=state))
        s.flush();s.add(db.EvidenceLink(incident_id='pending',job_id='context'))
    usage=namedtuple('Usage','total used free');freed={'bytes':0};original=storage.unlink
    def remove(path):
        n=original(path);freed['bytes']+=n;return n
    monkeypatch.setattr(storage,'unlink',remove)
    monkeypatch.setattr(storage,'limits',lambda:(100,1000))
    monkeypatch.setattr(storage.shutil,'disk_usage',lambda _:usage(10000,10000-freed['bytes'],freed['bytes']))
    result=storage.cleanup(emergency=True)
    assert result['jobs']==3
    for name in ('done','failed','cancelled'):assert not paths[name].exists()
    for name in ('recent','queued','processing','context','pending','approved','rejected','needed-context'):assert paths[name].exists(),name
    with db.Session() as s:assert s.get(db.Job,'failed').status=='purged'


def test_pressure_stops_after_reserve_recovered(monkeypatch):
    with db.transaction() as s:
        s.add(db.Source(id='source',name='camera',kind='rtsp'));s.flush()
        _,first=create_job(s,'first',created=time.time()-900)
        _,second=create_job(s,'second',created=time.time()-800)
    original=storage.unlink;space={'free':0}
    def remove(path):
        size=original(path);space['free']+=size;return size
    monkeypatch.setattr(storage,'unlink',remove);monkeypatch.setattr(storage,'limits',lambda:(1,8))
    Usage=namedtuple('Usage','total used free')
    monkeypatch.setattr(storage.shutil,'disk_usage',lambda _:Usage(100,100-space['free'],space['free']))
    result=storage.cleanup(emergency=True)
    assert result['jobs']==1 and not first.exists() and second.exists()


def test_manual_old_unsignalled_purged_but_signal_and_active_preserved(client,headers):
    old=time.time()-200*3600
    with db.transaction() as s:
        for name,state,flag in [('plain','done',False),('signal','done',True),('active','processing',False)]:
            path=db.DATA/'manual_uploads'/f'{name}.jpg';path.parent.mkdir(exist_ok=True);path.write_bytes(b'original')
            folder=db.DATA/'analyses'/name;folder.mkdir(parents=True,exist_ok=True);(folder/'s0.jpg').write_bytes(b'frame')
            s.add(db.ManualAnalysis(id=name,filename=name+'.jpg',media_type='photo',provider='local',path=str(path.relative_to(db.DATA)),sha256='0'*64,status=state,created=old,result={'summary':'original summary','frames':[{'id':'s0','path':str((folder/'s0.jpg').relative_to(db.DATA))}],'observations':[{'suspected_violation':flag}]}))
    result=storage.cleanup()
    assert result['analyses']==1
    assert not (db.DATA/'manual_uploads/plain.jpg').exists()
    for name in ('signal','active'):assert (db.DATA/'manual_uploads'/f'{name}.jpg').exists()
    report=client.get('/api/v2/analyses/plain',headers=headers).json()
    assert report['status']=='purged' and report['result']['summary']=='original summary' and report['result']['frames']==[]
    assert client.get('/api/v2/analyses/plain/images/s0',headers=headers).status_code==410


def test_orphans_active_capture_and_registered_files(monkeypatch):
    old=time.time()-7200
    def file(relative):
        path=db.DATA/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'data');os.utime(path,(old,old));return path
    orphan=file('captures/stale/session/orphan.mp4')
    active=file('captures/active/session/segment.mp4');(active.parent/'.active').touch()
    queued=file('uploads/queued.mp4')
    evidence=file('frames/permanent.jpg')
    with db.transaction() as s:
        s.add(db.Source(id='source',name='camera',kind='rtsp'));s.flush()
        s.add(db.Job(id='queued',source_id='source',path='uploads/queued.mp4',sha256='0'*64,ingest_key='q',captured_at=1,status='queued'));s.flush()
        s.add(db.Incident(id='event',source_id='source',job_id='queued',rule_id='r',track_id='t',category='x',description='x',detected_at=1,evidence={'frame':{'path':'frames/permanent.jpg'}}))
    storage.cleanup()
    assert not orphan.exists() and active.exists() and queued.exists() and evidence.exists()


def test_storage_routes_require_admin(client,headers):
    reviewer={'Authorization':'Bearer '+os.environ['OSC_REVIEWER_TOKEN']}
    assert client.post('/api/v2/maintenance/cleanup',headers=reviewer).status_code==403
    assert client.get('/api/v2/maintenance/storage',headers=headers).status_code==200
    assert client.post('/api/v2/maintenance/cleanup',headers=headers).status_code==200
