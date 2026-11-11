import json
import os
import hashlib
from io import BytesIO
import cv2
import numpy as np
from sqlalchemy import select
from PIL import Image
from osc import db
from osc.settings import decrypt,openrouter_settings
from osc.gallery import save_frame
from osc.manual import claim_manual,process_manual

def photo_bytes():
    out=BytesIO();Image.new('RGB',(300,200),'white').save(out,format='JPEG');return out.getvalue()
def upload(client,headers,**data):
    r=client.post('/api/v2/analyses',headers=headers,data=data,files={'file':('test.jpg',photo_bytes(),'image/jpeg')});assert r.status_code==202,r.text;return r.json()['id']

def test_password_login_cookie_expiry_and_csrf(client,monkeypatch):
    monkeypatch.setenv('OSC_PRESENTATION_USERNAME','presenter');monkeypatch.setenv('OSC_PRESENTATION_PASSWORD','test-password-at-least-12')
    assert client.post('/api/v2/login',json={'username':'presenter','password':'wrong'}).status_code==401
    r=client.post('/api/v2/login',json={'username':'presenter','password':'test-password-at-least-12'})
    assert r.status_code==200 and 'HttpOnly' in r.headers['set-cookie']
    assert client.get('/api/v2/status').json()['role']=='reviewer'
    assert client.post('/api/v2/analyses',headers={'Origin':'https://attacker.example'},files={'file':('x.jpg',photo_bytes())}).status_code==403
    assert client.put('/api/v2/settings/openrouter',json={'key':'forbidden'}).status_code==403
    client.post('/api/v2/logout');assert client.get('/api/v2/status').status_code==401

def test_login_rate_limit(client,monkeypatch):
    monkeypatch.setenv('OSC_PRESENTATION_USERNAME','presenter');monkeypatch.setenv('OSC_PRESENTATION_PASSWORD','test-password-at-least-12')
    for _ in range(10):assert client.post('/api/v2/login',json={'username':'presenter','password':'wrong'}).status_code==401
    assert client.post('/api/v2/login',json={'username':'presenter','password':'wrong'}).status_code==429

def test_camera_url_encrypted_and_reconnect_without_restart(client,headers):
    url='rtsp://user:test-secret@camera.example:554/11'
    r=client.post('/api/v2/sources',headers=headers,json={'name':'test','kind':'rtsp','enabled':True,'rtsp_url':url});assert r.status_code==201,r.text
    source=r.json();assert 'test-secret' not in r.text
    with db.Session() as s:
        connection=s.get(db.CameraConnection,source['id']);assert 'test-secret' not in connection.ciphertext;assert decrypt(connection.ciphertext)==url;revision=connection.revision
    assert client.post(f"/api/v2/sources/{source['id']}/reconnect",headers=headers).status_code==200
    with db.Session() as s:assert s.get(db.CameraConnection,source['id']).revision!=revision
    new='rtsp://camera.example:554/12'
    assert client.patch(f"/api/v2/sources/{source['id']}",headers=headers,json={'rtsp_url':new}).status_code==200
    with db.Session() as s:assert decrypt(s.get(db.CameraConnection,source['id']).ciphertext)==new
    assert 'test-secret' not in client.get('/api/v2/audit',headers=headers).text

def test_last_ten_frames_are_bounded_and_incident_files_untouched(client,headers):
    source=client.post('/api/v2/sources',headers=headers,json={'name':'x','kind':'upload'}).json()
    event_file=db.DATA/'frames'/'permanent.jpg';event_file.parent.mkdir(exist_ok=True);event_file.write_bytes(b'evidence')
    for i in range(14):save_frame(source['id'],np.zeros((20,30,3),np.uint8),float(i))
    frames=client.get(f"/api/v2/sources/{source['id']}/frames",headers=headers).json()
    assert len(frames)==10 and [f['captured_at'] for f in frames]==list(reversed(range(4,14)))
    assert len(list((db.DATA/'camera_frames'/source['id']).glob('*.jpg')))==10
    assert event_file.read_bytes()==b'evidence'
    path=f"/api/v2/sources/{source['id']}/frames/{frames[0]['id']}"
    assert client.get(path).status_code==401
    image=client.get(path,headers=headers);assert image.status_code==200 and hashlib.sha256(image.content).hexdigest()==frames[0]['sha256']

def test_provider_secret_saved_and_read_live_without_restart(client,headers):
    secret='test-provider-secret-not-real'
    assert client.put('/api/v2/settings/openrouter',headers=headers,json={'key':secret}).status_code==200
    assert secret not in client.get('/api/v2/settings/openrouter',headers=headers).text
    assert openrouter_settings()[0]==secret
    with db.Session() as s:assert secret not in s.get(db.Setting,'openrouter_key').value
    assert client.put('/api/v2/settings/openrouter',headers=headers,json={'clear':True}).status_code==200
    assert openrouter_settings()[0]==''

def test_photo_local_analysis_does_not_consume_camera_slots(client,headers):
    task_id=upload(client,headers,provider='local')
    class Detector:
        def detect(self,frame):return [{'label':'car','score':.8,'bbox':[.1,.1,.6,.6]}]
    task=claim_manual('worker');assert task.id==task_id
    process_manual(task,Detector(),'worker')
    data=client.get('/api/v2/analyses/'+task_id,headers=headers).json()
    assert data['status']=='done' and data['result']['objects'][0]['label']=='car'
    assert client.get('/api/v2/sources',headers=headers).json()==[]
    assert client.get(f'/api/v2/analyses/{task_id}/images/a0',headers=headers).status_code==200
    assert client.get('/api/v2/events',headers=headers).json()==[]

def test_openrouter_photo_one_call_and_native_crop(client,headers,monkeypatch):
    client.put('/api/v2/settings/openrouter',headers=headers,json={'key':'test-only-key'})
    seen=[]
    def call(items):
        seen.extend(items)
        return {'summary':'Признаков нарушений нет','observations':[],'readings':[{'frame_id':'p0','number':'Т540СХ790','readability':'readable'}],'model':'test'}
    monkeypatch.setattr('osc.manual.call_openrouter',call)
    task_id=upload(client,headers,provider='openrouter',region=json.dumps({'x':.1,'y':.2,'width':.5,'height':.25}))
    task=claim_manual('worker',False);process_manual(task,None,'worker')
    assert len(seen)==2 and seen[1]['width']==150 and seen[1]['height']==50
    result=client.get('/api/v2/analyses/'+task_id,headers=headers).json()
    assert result['status']=='done' and result['result']['provider']=='openrouter'

def test_photo_failure_is_explicit(client,headers):
    r=client.post('/api/v2/analyses',headers=headers,files={'file':('broken.jpg',b'not an image')});task=claim_manual('worker')
    process_manual(task,None,'worker');result=client.get('/api/v2/analyses/'+r.json()['id'],headers=headers).json()
    assert result['status']=='failed' and result['error']

def test_short_video_last_frame_is_decodable(client,headers,tmp_path):
    clip=tmp_path/'short.mp4';writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),2,(80,60));assert writer.isOpened()
    for _ in range(12):writer.write(np.zeros((60,80,3),np.uint8))
    writer.release()
    with clip.open('rb') as f:r=client.post('/api/v2/analyses',headers=headers,data={'provider':'local'},files={'file':('short.mp4',f,'video/mp4')})
    class Detector:
        def detect(self,frame):return []
    task=claim_manual('worker');process_manual(task,Detector(),'worker')
    result=client.get('/api/v2/analyses/'+r.json()['id'],headers=headers).json()
    assert result['status']=='done',result['error']
    assert result['result']['frame_count']==12
    assert max(f['timestamp'] for f in result['result']['frames'])==5.5

def test_openrouter_request_uses_selected_model_and_real_image_ids(monkeypatch):
    from osc import manual
    from osc.db import DATA
    path=DATA/'provider-image.jpg';path.write_bytes(photo_bytes());calls=[]
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,url,**kwargs):
            calls.append((url,kwargs['json']))
            return manual.httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({'summary':'Нарушений не обнаружено','observations':[],'readings':[{'frame_id':'p0','number':'Т540СХ790','readability':'readable'}]})}}]})
    monkeypatch.setattr(manual,'openrouter_settings',lambda:('test-secret','google/gemini-3.8-flash'))
    monkeypatch.setattr(manual.httpx,'Client',Client)
    items=[{'id':id,'path':path.name,'timestamp':0,'width':300,'height':200,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()} for id in ('s0','p0')]
    result=manual.call_openrouter(items)
    assert len(calls)==1 and calls[0][1]['model']=='google/gemini-3.8-flash'
    assert len([c for c in calls[0][1]['messages'][1]['content'] if c['type']=='image_url'])==2
    assert result['readings'][0]['frame_id']=='p0'


def test_presentation_credentials_change_in_ui_revokes_old_reviewer_session(client,headers,monkeypatch):
    monkeypatch.setenv('OSC_PRESENTATION_USERNAME','presenter');monkeypatch.setenv('OSC_PRESENTATION_PASSWORD','old-password-at-least-12')
    assert client.post('/api/v2/login',json={'username':'presenter','password':'old-password-at-least-12'}).status_code==200
    assert client.get('/api/v2/status').status_code==200
    password='new-password-at-least-12'
    r=client.put('/api/v2/settings/presentation',headers=headers,json={'username':'speaker','password':password});assert r.status_code==200,r.text
    assert client.get('/api/v2/status').status_code==401
    assert client.post('/api/v2/login',json={'username':'speaker','password':password}).status_code==200
    assert client.get('/api/v2/status').json()['role']=='reviewer'
    with db.Session() as s:assert password not in s.get(db.Setting,'presentation_password').value


def test_reviewer_api_token_cannot_sign_an_admin_session(client):
    import base64,hmac,time
    payload=base64.urlsafe_b64encode(json.dumps({'role':'admin','expires':time.time()+600}).encode()).decode().rstrip('=')
    forged=hmac.new(os.environ['OSC_REVIEWER_TOKEN'].encode(),payload.encode(),hashlib.sha256).hexdigest()
    client.cookies.set('osc_session',payload+'.'+forged,path='/api/v2')
    assert client.get('/api/v2/status').status_code==401
