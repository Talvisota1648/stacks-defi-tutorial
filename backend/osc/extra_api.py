import hashlib
import json
import os
import re
import uuid
from pathlib import Path
import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, SecretStr, model_validator
from sqlalchemy import select
from .db import Session, transaction, CameraFrame, Source, ManualAnalysis, Setting, CameraConnection, SourceArchive, Audit, DATA, path_for
from .api import view, manage, capacity
from . import auth
from .settings import encrypt, openrouter_settings

router=APIRouter(prefix='/api/v2')
router.add_api_route('/login',auth.login,methods=['POST'])
router.add_api_route('/token-login',auth.token_login,methods=['POST'])
router.add_api_route('/logout',auth.logout,methods=['POST'])

@router.get('/sources/{source_id}/frames')
def frames(source_id:str,user=Depends(view)):
    with Session() as s:
        if not s.get(Source,source_id):raise HTTPException(404,'Источник не найден')
        return [{'id':f.id,'captured_at':f.captured_at,'sha256':f.sha256} for f in s.scalars(select(CameraFrame).where(CameraFrame.source_id==source_id).order_by(CameraFrame.captured_at.desc(),CameraFrame.created.desc()).limit(10))]
@router.get('/sources/{source_id}/frames/{frame_id}')
def frame(source_id:str,frame_id:str,user=Depends(view)):
    with Session() as s:
        row=s.get(CameraFrame,frame_id)
        if not row or row.source_id!=source_id:raise HTTPException(404,'Кадр не найден')
        path=path_for(row.path)
        if not path.is_file():raise HTTPException(410,'Кадр уже обновлён')
        return FileResponse(path,media_type='image/jpeg',headers={'Cache-Control':'no-store','X-Content-SHA256':row.sha256})
@router.post('/sources/{source_id}/reconnect')
def reconnect(source_id:str,user=Depends(manage)):
    with transaction() as s:
        row=s.get(Source,source_id)
        if not row or row.kind!='rtsp':raise HTTPException(404,'RTSP-источник не найден')
        if s.get(SourceArchive,source_id):raise HTTPException(410,'Камера удалена; добавьте новое подключение')
        connection=s.get(CameraConnection,source_id)
        if not connection:connection=CameraConnection(source_id=source_id,ciphertext='');s.add(connection)
        connection.revision=str(uuid.uuid4());row.enabled=True;row.status='connecting';row.error=''
        s.add(Audit(actor=user,action='source_reconnect',entity=source_id))
    return {'ok':True}

class ProviderSettings(BaseModel):
    key: SecretStr | None = Field(default=None,max_length=500)
    model: str = Field(default='google/gemini-3.8-flash',pattern=r'^[A-Za-z0-9_.:/-]{1,120}$')
    clear: bool = False
@router.get('/settings/openrouter')
def provider_status(user=Depends(view)):
    try:key,model=openrouter_settings()
    except RuntimeError:raise HTTPException(503,'Не удалось прочитать настройки провайдера')
    return {'configured':bool(key),'model':model}
@router.put('/settings/openrouter')
def provider_save(body:ProviderSettings,user=Depends(manage)):
    with transaction() as s:
        for name,value in [('openrouter_model',body.model)]+([('openrouter_key','')] if body.clear else [('openrouter_key',encrypt(body.key.get_secret_value()))] if body.key and body.key.get_secret_value() else []):
            row=s.get(Setting,name)
            if not row:row=Setting(id=name,value=value);s.add(row)
            else:row.value=value
        s.add(Audit(actor=user,action='provider_settings_updated',entity='openrouter',details={'model':body.model,'key_changed':bool(body.key) or body.clear}))
    return {'ok':True}
@router.post('/settings/openrouter/test')
def provider_test(user=Depends(manage)):
    key,_=openrouter_settings()
    if not key:raise HTTPException(409,'Ключ не задан')
    try:
        response=httpx.get('https://openrouter.ai/api/v1/key',headers={'Authorization':'Bearer '+key},timeout=20)
        if response.status_code!=200:raise HTTPException(502,f'OpenRouter вернул HTTP {response.status_code}')
        data=response.json().get('data',{})
        return {'ok':True,'remaining':data.get('limit_remaining'),'usage':data.get('usage')}
    except httpx.RequestError:raise HTTPException(502,'OpenRouter недоступен с сервера') from None

@router.post('/analyses',status_code=202)
async def create_analysis(file:UploadFile=File(...),provider:str=Form('local'),region:str=Form(''),user=Depends(view)):
    if provider not in ('local','openrouter'):raise HTTPException(422,'Неизвестный способ анализа')
    if provider=='openrouter' and not openrouter_settings()[0]:raise HTTPException(409,'Администратору нужно добавить ключ OpenRouter в настройках сайта')
    name=(file.filename or 'file').replace('\\','/').split('/')[-1][:200]
    ext=Path(name).suffix.lower();photo=ext in ('.jpg','.jpeg','.png','.webp')
    if not photo and ext not in ('.mp4','.mov','.webm','.avi'):raise HTTPException(422,'Нужны JPG/PNG/WebP или MP4/MOV/WebM/AVI')
    try:
        r=json.loads(region) if region else {}
        if r and (set(r)!=set(('x','y','width','height')) or any(not isinstance(v,(int,float)) or isinstance(v,bool) or not 0<=v<=1 for v in r.values()) or r['width']<=0 or r['height']<=0 or r['x']+r['width']>1.000001 or r['y']+r['height']>1.000001):raise ValueError()
    except (ValueError,TypeError):raise HTTPException(422,'Некорректная область номера')
    with Session() as s:capacity(s)
    task_id=str(uuid.uuid4());folder=DATA/'manual_uploads';folder.mkdir(exist_ok=True);path=folder/f'{task_id}{ext}';size=0;digest=hashlib.sha256()
    try:
        with path.open('wb') as out:
            while chunk:=await file.read(1024*1024):
                size+=len(chunk)
                if size>(20 if photo else 250)*1024**2:raise HTTPException(413,'Фото до 20 МБ, видео до 250 МБ')
                out.write(chunk);digest.update(chunk)
        if not size:raise HTTPException(422,'Пустой файл')
        with transaction() as s:
            capacity(s);s.add(ManualAnalysis(id=task_id,filename=name,media_type='photo' if photo else 'video',provider=provider,path=str(path.relative_to(DATA)),sha256=digest.hexdigest(),region=r))
            s.add(Audit(actor=user,action='manual_analysis_created',entity=task_id,details={'provider':provider}))
        return {'id':task_id,'status':'queued'}
    except BaseException:path.unlink(missing_ok=True);raise
    finally:await file.close()

def analysis_json(row):return {k:getattr(row,k) for k in ('id','filename','media_type','provider','status','result','error','created','finished')}
@router.get('/analyses')
def analyses(user=Depends(view)):
    with Session() as s:return [dict(id=r.id,filename=r.filename,provider=r.provider,status=r.status,created=r.created,error=r.error) for r in s.scalars(select(ManualAnalysis).order_by(ManualAnalysis.created.desc()).limit(20))]
@router.get('/analyses/{task_id}')
def analysis(task_id:str,user=Depends(view)):
    with Session() as s:
        row=s.get(ManualAnalysis,task_id)
        if not row:raise HTTPException(404,'Анализ не найден')
        return analysis_json(row)
@router.get('/analyses/{task_id}/images/{image_id}')
def analysis_image(task_id:str,image_id:str,user=Depends(view)):
    with Session() as s:
        row=s.get(ManualAnalysis,task_id)
        item=next((f for f in row.result.get('frames',[]) if f['id']==image_id),None) if row else None
        if not item:raise HTTPException(404,'Изображение не найдено')
        path=path_for(item['path'])
        if not path.is_file():raise HTTPException(410,'Изображение недоступно')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise HTTPException(409,'Контрольная сумма не совпала')
        return FileResponse(path,media_type='image/jpeg',headers={'Cache-Control':'no-store'})

class PresentationSettings(BaseModel):
    username: str = Field(min_length=3,max_length=120,pattern=r'^[A-Za-z0-9_.@-]+$')
    password: SecretStr = Field(min_length=12,max_length=300)

@router.get('/settings/presentation')
def presentation_status(user=Depends(manage)):
    with Session() as s:
        row=s.get(Setting,'presentation_username')
        return {'username':row.value if row else os.getenv('OSC_PRESENTATION_USERNAME','presenter')}

@router.put('/settings/presentation')
def presentation_save(body:PresentationSettings,user=Depends(manage)):
    with transaction() as s:
        for name,value in [('presentation_username',body.username),('presentation_password',encrypt(body.password.get_secret_value())),('presentation_revision',str(uuid.uuid4()))]:
            row=s.get(Setting,name)
            if row:row.value=value
            else:s.add(Setting(id=name,value=value))
        s.add(Audit(actor=user,action='presentation_access_updated',entity='presentation',details={'username':body.username}))
    return {'ok':True}

@router.delete('/sources/{source_id}')
def archive_source(source_id:str,user=Depends(manage)):
    from .db import SourceArchive,Job
    with transaction() as s:
        row=s.get(Source,source_id)
        if not row:raise HTTPException(404,'Источник не найден')
        if not s.get(SourceArchive,source_id):
            s.add(SourceArchive(source_id=source_id));row.enabled=False;row.status='archived';row.error='';row.rule_state={}
            for job in s.scalars(select(Job).where(Job.source_id==source_id,Job.status=='queued')):job.status='cancelled';job.error='Камера удалена'
            connection=s.get(CameraConnection,source_id)
            if connection:s.delete(connection)
            s.add(Audit(actor=user,action='source_archived',entity=source_id,details={'evidence_preserved':True}))
    return {'ok':True,'evidence_preserved':True}

@router.get('/jobs/{job_id}/result')
def job_result(job_id:str,user=Depends(view)):
    from .db import Job,JobAnalysis
    with Session() as s:
        row=s.get(Job,job_id)
        if not row:raise HTTPException(404,'Задание не найдено')
        if row.status=='purged':raise HTTPException(410,'Срок хранения клипа без происшествия истёк')
        source=s.get(Source,row.source_id);report=s.get(JobAnalysis,job_id)
        return {'id':row.id,'source_id':row.source_id,'source_name':source.name if source else 'Архивный источник','status':row.status,'error':row.error,'captured_at':row.captured_at,'result':report.result if report else None}

@router.get('/jobs/{job_id}/images/{image_id}')
def job_image(job_id:str,image_id:str,user=Depends(view)):
    from .db import JobAnalysis
    with Session() as s:
        report=s.get(JobAnalysis,job_id)
        item=next((f for f in report.result.get('frames',[]) if f['id']==image_id),None) if report else None
        if not item:raise HTTPException(404,'Изображение не найдено')
        path=path_for(item['path'])
        if not path.is_file():raise HTTPException(410,'Срок хранения кадра истёк')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise HTTPException(409,'Контрольная сумма не совпала')
        return FileResponse(path,media_type='image/jpeg',headers={'Cache-Control':'no-store'})
