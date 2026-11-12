import hashlib
import os
import time
import cv2
import numpy as np
from osc import db
from osc.worker import claim, process, cleanup


def test_report_without_incident_and_archive_preserves_results(client, headers, tmp_path):
    source=client.post('/api/v2/sources',headers=headers,json={'name':'Test camera','kind':'upload','sample_fps':2,'enabled':True}).json()
    clip=tmp_path/'report.mp4'
    writer=cv2.VideoWriter(str(clip),cv2.VideoWriter_fourcc(*'mp4v'),2,(80,60))
    assert writer.isOpened()
    for _ in range(8):writer.write(np.zeros((60,80,3),np.uint8))
    writer.release()
    response=client.post(f"/api/v2/sources/{source['id']}/uploads",headers=headers,files={'file':('report.mp4',clip.read_bytes(),'video/mp4')})
    assert response.status_code==202,response.text
    class Detector:
        def detect(self,frame):return [{'label':'car','score':.85,'bbox':[.1,.1,.8,.8]}]
    job,src=claim('report-worker');process(job,src,Detector(),'report-worker')
    endpoint=f'/api/v2/jobs/{job.id}/result'
    assert client.get(endpoint).status_code==401
    result=client.get(endpoint,headers=headers).json()['result']
    assert result['analysed_frames']==8 and result['peak_objects']=={'car':1}
    assert result['object_observations']=={'car':8} and result['signals']==0
    assert len(result['frames'])==8 and client.get('/api/v2/events',headers=headers).json()==[]
    image_url=f'/api/v2/jobs/{job.id}/images/f0'
    assert client.get(image_url).status_code==401
    assert hashlib.sha256(client.get(image_url,headers=headers).content).hexdigest()==result['frames'][0]['sha256']
    reviewer={'Authorization':'Bearer '+os.environ['OSC_REVIEWER_TOKEN']}
    assert client.delete('/api/v2/sources/'+src.id,headers=reviewer).status_code==403
    assert client.patch('/api/v2/sources/'+src.id,headers=headers,json={'sample_fps':1}).status_code==200
    assert client.patch('/api/v2/sources/'+src.id,headers=headers,json={'sample_fps':10}).status_code==422
    assert client.delete('/api/v2/sources/'+src.id,headers=headers).status_code==200
    assert client.get('/api/v2/sources',headers=headers).json()==[]
    assert client.get('/api/v2/status',headers=headers).json()['sources']==0
    assert client.patch('/api/v2/sources/'+src.id,headers=headers,json={'enabled':True}).status_code==410
    assert client.post('/api/v2/sources/'+src.id+'/reconnect',headers=headers).status_code==404
    assert client.get(endpoint,headers=headers).json()['source_name']=='Test camera'
    assert client.get(image_url,headers=headers).status_code==200
    with db.transaction() as s:
        s.get(db.Job,job.id).created=time.time()-48*3600
        saved=s.get(db.JobAnalysis,job.id);saved.result={**saved.result,'completed_at':time.time()-48*3600}
    cleanup()
    assert client.get(endpoint,headers=headers).status_code==410
    assert client.get(image_url,headers=headers).status_code==404
