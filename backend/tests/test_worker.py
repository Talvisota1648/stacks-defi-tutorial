import time
import uuid
from osc import db
from osc.worker import claim,cleanup

def test_worker_lease_exclusive_and_recoverable():
    with db.transaction() as s:
        source=db.Source(id='source',name='x',kind='upload',enabled=True,rules=[]);s.add(source);s.flush()
        s.add(db.Job(id='job',source_id='source',path='test.mp4',sha256='0'*64,ingest_key='one',captured_at=time.time()))
    first=claim('one');assert first and not claim('two')
    with db.transaction() as s:s.get(db.Job,'job').lease=0;s.get(db.Source,'source').worker_lease=0
    second=claim('two');assert second[0].attempts==2 and second[0].owner=='two'

def test_cleanup_preserves_event_clips():
    with db.transaction() as s:
        s.add(db.Source(id='source',name='x',kind='upload'));s.flush()
        for name in ('plain','evidence'):
            (db.DATA/f'{name}.mp4').write_bytes(b'clip')
            s.add(db.Job(id=name,source_id='source',path=f'{name}.mp4',sha256='0'*64,ingest_key=name,captured_at=1,created=1,status='done'))
        s.flush();s.add(db.Incident(id='event',source_id='source',job_id='evidence',rule_id='r',track_id='t',category='vehicle_dwell',description='x',detected_at=1,evidence={}))
    cleanup()
    assert not (db.DATA/'plain.mp4').exists() and (db.DATA/'evidence.mp4').exists()

def test_cleanup_preserves_linked_context_clips():
    with db.transaction() as s:
        s.add(db.Source(id='source',name='x',kind='rtsp'));s.flush()
        for name in ('before','at-event'):
            (db.DATA/f'{name}.mp4').write_bytes(b'clip')
            s.add(db.Job(id=name,source_id='source',path=f'{name}.mp4',sha256='0'*64,ingest_key=name,captured_at=1,created=1,status='done'))
        s.flush();s.add(db.Incident(id='event',source_id='source',job_id='at-event',rule_id='r',track_id='t',category='vehicle_dwell',description='x',detected_at=1,evidence={}));s.flush()
        s.add(db.EvidenceLink(incident_id='event',job_id='before'))
    cleanup()
    assert (db.DATA/'before.mp4').exists()
