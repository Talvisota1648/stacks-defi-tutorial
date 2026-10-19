import hashlib
import os
import time
import uuid
from pathlib import Path
import cv2
import numpy as np
import pytest
from osc import db
from osc.worker import claim,process
from osc.detector import Detector

@pytest.mark.model
def test_ten_sources_real_cpu_inference_review_export(client,headers,tmp_path):
    model_path=Path(os.getenv('OSC_MODEL_PATH','models/yolox_nano.onnx'))
    image_path=Path(os.getenv('OSC_TEST_IMAGE','/tmp/osc2-bus.jpg'))
    if not model_path.exists() or not image_path.exists():pytest.skip('Needs downloaded model and configured OSC_TEST_IMAGE test fixture')
    detector=Detector();image=cv2.imread(str(image_path))
    assert any(d['label']=='bus' for d in detector.detect(image))
    assert not detector.detect(np.zeros_like(image))
    clip=tmp_path/'stationary.mp4'
    writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),2,(image.shape[1],image.shape[0]))
    assert writer.isOpened()
    for _ in range(12):writer.write(image)
    writer.release()
    rules=[{'id':'z','type':'vehicle_dwell','polygon':[[0,0],[1,0],[1,1],[0,1]],'dwell_seconds':3,'cooldown_seconds':120}]
    for i in range(10):
        source=client.post('/api/v2/sources',headers=headers,json={'name':f'Camera {i+1}','kind':'upload','enabled':True,'sample_fps':1,'rules':rules}).json()
        with clip.open('rb') as f:response=client.post(f"/api/v2/sources/{source['id']}/uploads",headers=headers,files={'file':('clip.mp4',f,'video/mp4')})
        assert response.status_code==202,response.text
    for i in range(10):
        task=claim('test-worker');assert task
        process(*task,detector,'test-worker')
    events=client.get('/api/v2/events',headers=headers).json()
    assert len(events)==10
    assert client.get('/integration/v1/events',headers=headers).json()['items']==[]
    for event in events:
        assert event['evidence']['label']=='bus'
        frame=client.get(f"/api/v2/events/{event['id']}/evidence/frame",headers=headers)
        assert frame.status_code==200 and hashlib.sha256(frame.content).hexdigest()==event['evidence']['frame']['sha256']
    decision=client.post(f"/api/v2/events/{events[0]['id']}/review",headers=headers,json={'decision':'approved','version':1,'comment':'Verified test event'})
    assert decision.status_code==200
    assert len(client.get('/integration/v1/events',headers=headers).json()['items'])==1
