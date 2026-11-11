import json
import hashlib
import cv2
import numpy as np
import pytest
from PIL import Image
from io import BytesIO
from osc import db
from osc.manual import call_openrouter,claim_manual,process_manual
from osc.worker import claim,process
from osc.scene_policy import ScenePolicy,prompt


def response(observations):return {'summary':'Возможное ДТП: сильно повреждённая машина на обочине','observations':observations,'readings':[]}
def damaged():return {'frame_id':'s0','description':'Деформирован передок автомобиля, машина стоит на обочине вне эвакуатора','suspected_violation':True,'category':'damaged_vehicle','severity':'warning','bbox':[.1,.1,.9,.9]}
def fake_http(monkeypatch,raw,seen):
    class Client:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,url,**kwargs):
            seen.append((url,kwargs))
            class Result:
                status_code=200
                def json(self):return {'choices':[{'message':{'content':json.dumps(raw)}}]}
            return Result()
    monkeypatch.setattr('osc.manual.httpx.Client',Client)
def image_item():
    path=db.DATA/'scene.jpg';Image.new('RGB',(120,100),'white').save(path)
    return {'id':'s0','path':'scene.jpg','width':120,'height':100,'timestamp':0,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def test_edit_policy_admin_only_and_validation(client,headers):
    data=ScenePolicy(custom_prompt='Выявлять перекрытый пожарный проезд',forbidden_objects=['Бетонный блок на тротуаре']).model_dump()
    assert client.put('/api/v2/settings/scene-policy',json=data).status_code==401
    assert client.put('/api/v2/settings/scene-policy',headers=headers,json=data).status_code==200
    saved=client.get('/api/v2/settings/scene-policy',headers=headers).json()
    assert saved['policy']['custom_prompt']==data['custom_prompt'] and 'damaged_vehicle' in saved['catalog']
    assert client.put('/api/v2/settings/scene-policy',headers=headers,json={**data,'enabled_types':['fake']}).status_code==422
    assert client.put('/api/v2/settings/scene-policy',headers=headers,json={**data,'camera_interval':1}).status_code==422
    client.put('/api/v2/settings/openrouter',headers=headers,json={'clear':True})
    assert client.put('/api/v2/settings/scene-policy',headers=headers,json={**data,'camera_enabled':True}).status_code==409


def test_openrouter_prompt_flags_damage_and_keeps_tow_exception(client,headers,monkeypatch):
    client.put('/api/v2/settings/openrouter',headers=headers,json={'key':'test-only-key'})
    config=ScenePolicy(custom_prompt='Контролировать пожарный проезд',forbidden_objects=['Куча кирпича']).model_dump()
    client.put('/api/v2/settings/scene-policy',headers=headers,json=config)
    seen=[];fake_http(monkeypatch,response([damaged()]),seen)
    result=call_openrouter([image_item()])
    assert result['observations'][0]['category']=='damaged_vehicle' and len(seen)==1
    text=seen[0][1]['json']['messages'][1]['content'][0]['text']
    assert 'Куча кирпича' in text and 'пожарный проезд' in text and 'эвакуатора' in text and 'сплошной' in text
    assert result['scene_analysis']=='completed'


@pytest.mark.parametrize('box',[[.9,.1,.1,.8],[-1,0,1,1],[0,0,float('nan'),1],'wrong'])
def test_invalid_model_boxes_are_rejected(client,headers,monkeypatch,box):
    client.put('/api/v2/settings/openrouter',headers=headers,json={'key':'test-only-key'})
    fake_http(monkeypatch,response([{**damaged(),'bbox':box}]),[])
    with pytest.raises(ValueError,match='некорректный отчёт'):call_openrouter([image_item()])


def test_manual_local_vlm_highlights_damage_without_paid_provider(client,headers,monkeypatch):
    config=ScenePolicy(local_enabled=True,local_url='http://localhost:11434/v1').model_dump()
    client.put('/api/v2/settings/scene-policy',headers=headers,json=config)
    seen=[];fake_http(monkeypatch,response([damaged()]),seen)
    out=BytesIO();Image.new('RGB',(120,100),'white').save(out,format='JPEG')
    r=client.post('/api/v2/analyses',headers=headers,data={'provider':'local'},files={'file':('damage.jpg',out.getvalue(),'image/jpeg')})
    class Detector:
        def detect(self,frame):return []
    task=claim_manual('worker');process_manual(task,Detector(),'worker')
    report=client.get('/api/v2/analyses/'+r.json()['id'],headers=headers).json()
    assert report['status']=='done' and report['result']['observations'][0]['suspected_violation']
    assert seen[0][0]=='http://localhost:11434/v1/chat/completions'
    assert 'Authorization' not in seen[0][1]['headers']
    frame=next(f for f in report['result']['frames'] if f['id']=='a0')
    img=cv2.imread(str(db.path_for(frame['path'])))
    assert np.any((img[:,:,2]>150)&(img[:,:,1]<100))


def test_camera_scene_creates_reviewable_incident_with_no_yolox_objects(client,headers,monkeypatch,tmp_path):
    client.put('/api/v2/settings/openrouter',headers=headers,json={'key':'test-only-key'})
    config=ScenePolicy(camera_enabled=True,camera_interval=60).model_dump()
    assert client.put('/api/v2/settings/scene-policy',headers=headers,json=config).status_code==200
    seen=[];fake_http(monkeypatch,response([damaged()]),seen)
    source=client.post('/api/v2/sources',headers=headers,json={'name':'Road camera','kind':'upload','enabled':True,'sample_fps':1}).json()
    clip=tmp_path/'scene.mp4';writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),2,(120,100))
    for _ in range(8):writer.write(np.full((100,120,3),255,np.uint8))
    writer.release()
    client.post(f"/api/v2/sources/{source['id']}/uploads",headers=headers,files={'file':('scene.mp4',clip.read_bytes(),'video/mp4')})
    class Detector:
        def detect(self,frame):return []
    task=claim('worker');process(*task,Detector(),'worker')
    report=client.get(f'/api/v2/jobs/{task[0].id}/result',headers=headers).json()['result']
    assert report['scene']['status']=='completed' and report['signals']==1
    image=client.get(f'/api/v2/jobs/{task[0].id}/images/f0',headers=headers)
    assert image.status_code==200 and hashlib.sha256(image.content).hexdigest()==report['frames'][0]['sha256']
    pixels=cv2.imdecode(np.frombuffer(image.content,np.uint8),cv2.IMREAD_COLOR)
    assert np.any((pixels[:,:,2]>150)&(pixels[:,:,1]<100))
    events=client.get('/api/v2/events',headers=headers).json()
    assert len(events)==1 and events[0]['category']=='damaged_vehicle' and events[0]['status']=='pending'
    assert events[0]['evidence']['detector_score'] is None
    assert client.get(f"/api/v2/events/{events[0]['id']}/evidence/frame",headers=headers).status_code==200
    assert client.get('/integration/v1/events',headers=headers).json()['items']==[]
    assert len(seen)==1
    # A subsequent clip stays under the configured API frequency, even without YOLOX detections.
    client.post(f"/api/v2/sources/{source['id']}/uploads",headers={**headers,'Idempotency-Key':'second'},files={'file':('scene.mp4',clip.read_bytes(),'video/mp4')})
    task=claim('worker');process(*task,Detector(),'worker')
    assert len(seen)==1
    assert client.get(f'/api/v2/jobs/{task[0].id}/result',headers=headers).json()['result']['scene']['status']=='interval'
    with db.transaction() as s:s.get(db.CameraSceneState,source['id']).next_attempt=0
    client.post(f"/api/v2/sources/{source['id']}/uploads",headers={**headers,'Idempotency-Key':'third'},files={'file':('scene.mp4',clip.read_bytes(),'video/mp4')})
    task=claim('worker');process(*task,Detector(),'worker')
    assert len(seen)==2 and len(client.get('/api/v2/events',headers=headers).json())==1
    repeat=client.get(f'/api/v2/jobs/{task[0].id}/result',headers=headers).json()['result']
    assert repeat['signals']==0 and repeat['scene']['observations'][0]['suspected_violation']


def test_processing_api_has_no_incomplete_result(client,headers):
    out=BytesIO();Image.new('RGB',(20,20),'white').save(out,format='JPEG')
    task=client.post('/api/v2/analyses',headers=headers,files={'file':('test.jpg',out.getvalue(),'image/jpeg')}).json()
    data=client.get('/api/v2/analyses/'+task['id'],headers=headers).json()
    assert data['status']=='queued' and data['result'] is None


def test_camera_provider_failure_is_visible_without_losing_object_report(client,headers,monkeypatch,tmp_path):
    client.put('/api/v2/settings/openrouter',headers=headers,json={'key':'test-only-key'})
    client.put('/api/v2/settings/scene-policy',headers=headers,json=ScenePolicy(camera_enabled=True).model_dump())
    def fail(*args,**kwargs):raise ValueError('invalid provider report')
    monkeypatch.setattr('osc.camera_scene.call_openrouter',fail)
    source=client.post('/api/v2/sources',headers=headers,json={'name':'camera','kind':'upload','enabled':True}).json()
    clip=tmp_path/'scene.mp4';writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),2,(120,100))
    for _ in range(4):writer.write(np.zeros((100,120,3),np.uint8))
    writer.release()
    client.post(f"/api/v2/sources/{source['id']}/uploads",headers=headers,files={'file':('scene.mp4',clip.read_bytes(),'video/mp4')})
    class Detector:
        def detect(self,frame):return [{'label':'car','score':.8,'bbox':[.1,.1,.8,.8]}]
    task=claim('worker');process(*task,Detector(),'worker')
    report=client.get(f'/api/v2/jobs/{task[0].id}/result',headers=headers).json()
    assert report['status']=='done' and report['error']
    assert report['result']['scene']['status']=='failed' and report['result']['peak_objects']=={'car':1}
    assert client.get('/api/v2/events',headers=headers).json()==[]
