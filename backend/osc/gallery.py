import hashlib
import uuid
import cv2
from sqlalchemy import select
from .db import DATA, CameraFrame, transaction, path_for

def save_frame(source_id,frame,captured_at):
    folder=DATA/'camera_frames'/source_id;folder.mkdir(parents=True,exist_ok=True)
    h,w=frame.shape[:2]
    if max(h,w)>1280:frame=cv2.resize(frame,(round(w*1280/max(h,w)),round(h*1280/max(h,w))))
    frame_id=str(uuid.uuid4());path=folder/f'{frame_id}.jpg'
    if not cv2.imwrite(str(path),frame,[cv2.IMWRITE_JPEG_QUALITY,85]):raise RuntimeError('Cannot save camera frame')
    stale=[]
    try:
        with transaction() as s:
            s.add(CameraFrame(id=frame_id,source_id=source_id,captured_at=captured_at,path=str(path.relative_to(DATA)),sha256=hashlib.sha256(path.read_bytes()).hexdigest()));s.flush()
            stale=list(s.scalars(select(CameraFrame).where(CameraFrame.source_id==source_id).order_by(CameraFrame.captured_at.desc(),CameraFrame.created.desc()).offset(10)))
            for row in stale:s.delete(row)
        for row in stale:path_for(row.path).unlink(missing_ok=True)
    except BaseException:path.unlink(missing_ok=True);raise
