import os
import time
import uuid
import hashlib
from concurrent.futures import ThreadPoolExecutor
from sqlalchemy import select
from osc import db

def make_source(client,headers,**extra):
    response=client.post('/api/v2/sources',headers=headers,json={'name':'Тест','kind':'upload','enabled':True,**extra});assert response.status_code==201,response.text;return response.json()
def seed(client,headers):
    source=make_source(client,headers)
    with db.transaction() as s:
        job=db.Job(id=str(uuid.uuid4()),source_id=source['id'],path='x.mp4',sha256='x'*64,ingest_key=str(uuid.uuid4()),captured_at=time.time(),status='done');s.add(job);s.flush()
        event=db.Incident(id=str(uuid.uuid4()),source_id=source['id'],job_id=job.id,rule_id='zone',track_id=str(uuid.uuid4()),category='vehicle_dwell',description='Кандидат для проверки',detected_at=time.time(),evidence={'frame':{'path':'x.jpg','sha256':'x'*64},'clip':{'path':'x.mp4','sha256':'x'*64}});s.add(event);s.flush();return event.id

def test_auth_and_roles(client,headers):
    assert client.get('/api/v2/sources').status_code==401
    assert client.get('/api/v2/sources',headers={'Authorization':headers['Authorization'][7:]}).status_code==401
    reviewer={'Authorization':'Bearer '+os.environ['OSC_REVIEWER_TOKEN']}
    assert client.post('/api/v2/sources',headers=reviewer,json={'name':'x','kind':'upload'}).status_code==403
    assert client.get('/api/v2/status',headers=reviewer).json()['role']=='reviewer'

def test_source_cap_is_atomic(client,headers):
    for _ in range(9):make_source(client,headers)
    def create(_):return client.post('/api/v2/sources',headers=headers,json={'name':'Последняя','kind':'upload'}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:assert sorted(pool.map(create,range(2)))==[201,409]
    assert len(client.get('/api/v2/sources',headers=headers).json())==10

def test_rtsp_credentials_are_env_only(client,headers):
    bad=client.post('/api/v2/sources',headers=headers,json={'name':'Камера','kind':'rtsp','source_env':'rtsp://private:password@localhost'})
    assert bad.status_code==422
    source=make_source(client,headers,kind='rtsp',source_env='CAMERA_01_URL')
    assert source['source_env']=='CAMERA_01_URL'
    assert client.post('/api/v2/sources',headers=headers,json={'name':'x','kind':'upload','rules':[{'id':'z','type':'vehicle_dwell','polygon':[[0,0],[0,0],[0,0]]}]}).status_code==422

def test_upload_idempotency_and_disabled_source(client,headers):
    source=make_source(client,headers)
    a=client.post(f"/api/v2/sources/{source['id']}/uploads",headers=headers,files={'file':('a.mp4',b'video bytes')})
    b=client.post(f"/api/v2/sources/{source['id']}/uploads",headers=headers,files={'file':('other.mp4',b'video bytes')})
    assert a.status_code==202 and b.status_code==202
    assert a.json()['job_id']==b.json()['job_id'] and b.json()['duplicate']
    client.patch(f"/api/v2/sources/{source['id']}",headers=headers,json={'enabled':False})
    assert client.post(f"/api/v2/sources/{source['id']}/uploads",headers=headers,files={'file':('a.mp4',b'x')}).status_code==409

def test_mandatory_review_and_cursor_uses_approval_order(client,headers):
    older=seed(client,headers);newer=seed(client,headers)
    integration={'Authorization':'Bearer '+os.environ['OSC_INTEGRATION_TOKEN']}
    assert client.get('/integration/v1/events',headers=integration).json()['items']==[]
    assert client.get(f'/api/v2/events/{older}/evidence/frame',headers=integration).status_code==404
    review={'decision':'approved','version':1,'comment':'Проверено специалистом'}
    assert client.post(f'/api/v2/events/{newer}/review',headers=headers,json=review).status_code==200
    first=client.get('/integration/v1/events',headers=integration).json()
    assert first['items'][0]['event']['id']==newer
    assert client.post(f'/api/v2/events/{newer}/review',headers=headers,json=review).status_code==409
    client.post(f'/api/v2/events/{older}/review',headers=headers,json=review)
    second=client.get('/integration/v1/events',headers=integration,params={'cursor':first['next_cursor']}).json()
    assert second['items'][0]['event']['id']==older
    assert len(client.get('/api/v2/audit',headers=headers).json())>=4

def test_rejected_does_not_export_and_evidence_integrity(client,headers):
    event=seed(client,headers)
    payload=b'jpeg-original';(db.DATA/'x.jpg').write_bytes(payload)
    with db.transaction() as s:
        row=s.get(db.Incident,event);row.evidence={**row.evidence,'frame':{'path':'x.jpg','sha256':hashlib.sha256(payload).hexdigest()}}
    assert client.get(f'/api/v2/events/{event}/evidence/frame',headers=headers).content==payload
    (db.DATA/'x.jpg').write_bytes(b'modified')
    assert client.get(f'/api/v2/events/{event}/evidence/frame',headers=headers).status_code==409
    assert client.post(f'/api/v2/events/{event}/review',headers=headers,json={'decision':'rejected','version':1,'comment':'Недостаточно оснований'}).status_code==200
    assert client.get('/integration/v1/events',headers=headers).json()['items']==[]

def test_upload_can_be_reanalysed_after_zone_configuration(client,headers):
    source=make_source(client,headers)
    endpoint=f"/api/v2/sources/{source['id']}/uploads"
    first=client.post(endpoint,headers=headers,files={'file':('a.mp4',b'video')}).json()
    rule={'id':'zone','type':'vehicle_dwell','polygon':[[0,0],[1,0],[1,1],[0,1]],'dwell_seconds':3}
    client.patch(f"/api/v2/sources/{source['id']}",headers=headers,json={'rules':[rule]})
    second=client.post(endpoint,headers=headers,files={'file':('a.mp4',b'video')}).json()
    assert not second['duplicate'] and first['job_id']!=second['job_id']
