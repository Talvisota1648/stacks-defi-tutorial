import hashlib
import os
import urllib.request
from pathlib import Path
from .detector import MODEL_SHA256

def main():
    target=Path(os.getenv('OSC_MODEL_PATH','models/yolox_nano.onnx'));target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==MODEL_SHA256:
        print('Verified YOLOX Nano model already installed');return
    temp=target.with_suffix('.download')
    try:
        with urllib.request.urlopen('https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx',timeout=60) as response,temp.open('wb') as out:
            while chunk:=response.read(1024*1024):out.write(chunk)
        if hashlib.sha256(temp.read_bytes()).hexdigest()!=MODEL_SHA256:raise RuntimeError('Model checksum verification failed')
        temp.replace(target);print('YOLOX Nano downloaded and verified')
    finally:temp.unlink(missing_ok=True)
if __name__=='__main__':main()
