import hashlib
import os
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort

MODEL_SHA256='c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d'
LABELS={0:'person',2:'car',3:'motorcycle',5:'bus',7:'truck'}
class Detector:
    def __init__(self):
        path=Path(os.getenv('OSC_MODEL_PATH','models/yolox_nano.onnx'))
        if not path.is_file():raise RuntimeError('Model file missing: run python -m osc.download_model')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=MODEL_SHA256:raise RuntimeError('Model checksum mismatch')
        requested=os.getenv('OSC_DEVICE','cpu')
        if requested not in ('cpu','cuda'):raise RuntimeError('OSC_DEVICE must be cpu or cuda')
        if requested=='cuda' and 'CUDAExecutionProvider' not in ort.get_available_providers():raise RuntimeError('CUDA provider unavailable; install GPU runtime and drivers')
        options=ort.SessionOptions();options.intra_op_num_threads=int(os.getenv('OSC_INFERENCE_THREADS','2'))
        self.session=ort.InferenceSession(str(path),sess_options=options,providers=['CUDAExecutionProvider','CPUExecutionProvider'] if requested=='cuda' else ['CPUExecutionProvider'])
        if requested=='cuda' and self.session.get_providers()[0]!='CUDAExecutionProvider':raise RuntimeError('CUDA initialization failed; refusing silent CPU fallback')
        self.provider=self.session.get_providers()[0];self.name=self.session.get_inputs()[0].name
        self.size=416;grids=[];strides=[]
        for stride in (8,16,32):
            y,x=np.meshgrid(np.arange(self.size//stride),np.arange(self.size//stride),indexing='ij')
            grids.append(np.stack((x,y),axis=2).reshape(-1,2));strides.append(np.full((x.size,1),stride))
        self.grid=np.concatenate(grids);self.stride=np.concatenate(strides)
    def detect(self,frame):
        h,w=frame.shape[:2];ratio=min(self.size/h,self.size/w)
        resized=cv2.resize(frame,(int(w*ratio),int(h*ratio)))
        image=np.full((self.size,self.size,3),114,dtype=np.uint8);image[:resized.shape[0],:resized.shape[1]]=resized
        output=self.session.run(None,{self.name:np.ascontiguousarray(image.transpose(2,0,1)[None],dtype=np.float32)})[0][0].copy()
        output[:,:2]=(output[:,:2]+self.grid)*self.stride
        output[:,2:4]=np.exp(output[:,2:4])*self.stride
        results=[]
        for class_id,label in LABELS.items():
            scores=output[:,4]*output[:,5+class_id];chosen=np.flatnonzero(scores>=0.4)
            if not len(chosen):continue
            centers=output[chosen,:2]/ratio;sizes=output[chosen,2:4]/ratio
            boxes=np.column_stack((centers-sizes/2,sizes))
            keep=cv2.dnn.NMSBoxes(boxes.tolist(),scores[chosen].tolist(),0.4,0.45)
            for local in np.asarray(keep).reshape(-1):
                x,y,bw,bh=boxes[local]
                results.append({'label':label,'score':float(scores[chosen[local]]),'bbox':[max(0.,float(x/w)),max(0.,float(y/h)),min(1.,float((x+bw)/w)),min(1.,float((y+bh)/h))]})
        return results
