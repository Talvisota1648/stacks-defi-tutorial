import hashlib
import hmac
import json
import os
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException, Header, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from sqlalchemy import select, func, update
from .db import init_db, Session, transaction, Source, Job, Incident, Outbox, Audit, Heartbeat, DATA, path_for
from .schemas import SourceCreate, SourceUpdate, Review

@asynccontextmanager
async def lifespan(app):
    init_db()
    yield
app = FastAPI(title='ОСЦ MVP 2.0', version='2.0.0', lifespan=lifespan)

def actor(authorization: str = Header(default='')):
    if not authorization.startswith('Bearer '): raise HTTPException(401, 'Требуется Bearer-токен')
    token = authorization[7:]
    for role in ('admin','reviewer','ingest','integration'):
        expected = os.getenv(f'OSC_{role.upper()}_TOKEN', '')
        if len(expected) >= 24 and hmac.compare_digest(token, expected): return role
    raise HTTPException(401, 'Требуется действующий Bearer-токен')
def require(*roles):
    def permission(user=Depends(actor)):
        if user not in roles: raise HTTPException(403, 'Недостаточно прав')
        return user
    return permission
manage = require('admin')
view = require('admin','reviewer')

def source_json(s):
    result={k:getattr(s,k) for k in ('id','name','kind','source_env','enabled','sample_fps','latitude','longitude','rules','status','last_frame','error','created')}
    if s.enabled and s.kind=='rtsp' and s.status=='online' and s.last_frame and time.time()-s.last_frame>30:result['status']='stalled'
    return result
def event_json(e):
    return {k:getattr(e,k) for k in ('id','source_id','job_id','rule_id','track_id','category','description','detected_at','evidence','location','status','version','reviewer','comment','reviewed_at')}
def capacity(s):
    if s.scalar(select(func.count()).select_from(Job).where(Job.status.in_(['queued','processing']))) >= int(os.getenv('OSC_MAX_QUEUE','300')): raise HTTPException(429,'Очередь заполнена; повторите позже')
    if shutil.disk_usage(DATA).free < int(os.getenv('OSC_MIN_FREE_MB','512'))*1024**2: raise HTTPException(507,'Недостаточно места для материалов')

@app.get('/health')
def health(): return {'service':'osc-api','version':'2.0.0'}
@app.get('/api/v2/status')
def status(user=Depends(view)):
    with Session() as s:
        return {'role':user, 'sources':s.scalar(select(func.count()).select_from(Source)), 'pending':s.scalar(select(func.count()).select_from(Incident).where(Incident.status=='pending')), 'queue':s.scalar(select(func.count()).select_from(Job).where(Job.status.in_(['queued','processing']))), 'failed_jobs':s.scalar(select(func.count()).select_from(Job).where(Job.status=='failed')), 'processes':[{'id':h.id,'role':h.role,'online':time.time()-h.seen<45,'last_seen':h.seen,'details':h.details} for h in s.scalars(select(Heartbeat))], 'source_limit':10}
@app.get('/api/v2/sources')
def sources(user=Depends(view)):
    with Session() as s: return [source_json(row) for row in s.scalars(select(Source).order_by(Source.created))]
@app.post('/api/v2/sources', status_code=201)
def add_source(body:SourceCreate,user=Depends(manage)):
    with transaction() as s:
        if s.scalar(select(func.count()).select_from(Source)) >= 10: raise HTTPException(409,'Пилот ограничен десятью источниками')
        row=Source(id=str(uuid.uuid4()),**body.model_dump(),status='connecting' if body.enabled else 'disabled')
        s.add(row);s.flush();s.add(Audit(actor=user,action='source_created',entity=row.id));return source_json(row)
@app.patch('/api/v2/sources/{source_id}')
def edit_source(source_id:str,body:SourceUpdate,user=Depends(manage)):
    with transaction() as s:
        row=s.get(Source,source_id)
        if not row: raise HTTPException(404,'Источник не найден')
        values=body.model_dump(exclude_none=True)
        if 'rules' in values:
            if len({r['id'] for r in values['rules']}) != len(values['rules']): raise HTTPException(422,'ID правил повторяются')
            row.rule_state={}
        for k,v in values.items():setattr(row,k,v)
        if 'enabled' in values: row.status='connecting' if row.enabled else 'disabled'
        s.add(Audit(actor=user,action='source_updated',entity=row.id,details=values));return source_json(row)
@app.post('/api/v2/sources/{source_id}/uploads',status_code=202)
async def upload(source_id:str,file:UploadFile=File(...),captured_at:float|None=Form(None),latitude:float|None=Form(None),longitude:float|None=Form(None),idempotency_key:str|None=Header(None),user=Depends(require('admin','ingest'))):
    with Session() as s:
        source=s.get(Source,source_id)
        if not source or source.kind!='upload':raise HTTPException(404,'Нужен источник типа upload')
        if not source.enabled:raise HTTPException(409,'Источник выключен')
        capacity(s)
    if (latitude is None)!=(longitude is None) or (latitude is not None and not(-90<=latitude<=90 and -180<=longitude<=180)):raise HTTPException(422,'Некорректные координаты')
    if captured_at is not None and not(0<captured_at<time.time()+60):raise HTTPException(422,'Некорректное время съёмки')
    if idempotency_key and (len(idempotency_key)>100 or not idempotency_key.isascii()):raise HTTPException(422,'Некорректный Idempotency-Key')
    job_id=str(uuid.uuid4());folder=DATA/'uploads';folder.mkdir(exist_ok=True)
    target=folder/f'{job_id}.mp4';temporary=target.with_suffix('.part');digest=hashlib.sha256();size=0
    try:
        with temporary.open('wb') as out:
            while chunk:=await file.read(1024*1024):
                size+=len(chunk)
                if size>250*1024**2:raise HTTPException(413,'Максимум 250 МБ')
                digest.update(chunk);out.write(chunk)
        if not size:raise HTTPException(422,'Пустой файл')
        with transaction() as s:
            active=s.get(Source,source_id)
            if not active or not active.enabled:raise HTTPException(409,'Источник выключен')
            revision=hashlib.sha256(json.dumps({'rules':active.rules,'fps':active.sample_fps},sort_keys=True).encode()).hexdigest()[:12]
            key=f'{idempotency_key or digest.hexdigest()}:{revision}'
            capacity(s)
            old=s.scalar(select(Job).where(Job.source_id==source_id,Job.ingest_key==key))
            if old:return {'job_id':old.id,'status':old.status,'duplicate':True}
            temporary.replace(target)
            active.last_frame=time.time();active.status='online'
            row=Job(id=job_id,source_id=source_id,path=str(target.relative_to(DATA)),sha256=digest.hexdigest(),ingest_key=key,captured_at=captured_at or time.time(),location={'latitude':latitude,'longitude':longitude,'origin':'uploader'} if latitude is not None else {})
            s.add(row);s.add(Audit(actor=user,action='uploaded',entity=job_id));s.flush();return {'job_id':row.id,'status':row.status,'duplicate':False}
    except BaseException:
        target.unlink(missing_ok=True);raise
    finally:temporary.unlink(missing_ok=True);await file.close()
@app.get('/api/v2/jobs')
def jobs(user=Depends(view)):
    with Session() as s:return [{k:getattr(j,k) for k in ('id','source_id','status','attempts','error','captured_at','created')} for j in s.scalars(select(Job).order_by(Job.created.desc()).limit(100))]
@app.get('/api/v2/events')
def events(status:str=Query('pending',pattern='^(pending|approved|rejected|all)$'),limit:int=Query(50,ge=1,le=200),user=Depends(view)):
    with Session() as s:
        query=select(Incident).order_by(Incident.detected_at.desc()).limit(limit)
        if status!='all':query=query.where(Incident.status==status)
        return [event_json(e) for e in s.scalars(query)]
@app.post('/api/v2/events/{event_id}/review')
def review(event_id:str,body:Review,user=Depends(require('admin','reviewer'))):
    with transaction() as s:
        row=s.get(Incident,event_id)
        if not row:raise HTTPException(404,'Событие не найдено')
        if row.status!='pending' or row.version!=body.version:raise HTTPException(409,'Событие уже проверено или версия устарела')
        row.status=body.decision;row.version+=1;row.reviewer=os.getenv('OSC_REVIEWER_NAME','Специалист') if user=='reviewer' else 'Администратор';row.comment=body.comment;row.reviewed_at=time.time()
        if body.decision=='approved':s.add(Outbox(incident_id=row.id))
        s.add(Audit(actor=row.reviewer,action=body.decision,entity=row.id,details={'comment':body.comment,'version':row.version}));s.flush();return event_json(row)
@app.get('/integration/v1/events')
def exported_events(cursor:int=Query(0,ge=0),limit:int=Query(100,ge=1,le=200),user=Depends(require('integration','admin'))):
    with Session() as s:
        rows=s.execute(select(Outbox,Incident).join(Incident,Outbox.incident_id==Incident.id).where(Outbox.id>cursor,Incident.status=='approved').order_by(Outbox.id).limit(limit)).all()
        return {'items':[{'sequence':o.id,'event':event_json(e)} for o,e in rows],'next_cursor':rows[-1][0].id if rows else cursor}
@app.get('/api/v2/events/{event_id}/evidence/{kind}')
def evidence(event_id:str,kind:str,user=Depends(require('admin','reviewer','integration'))):
    with Session() as s:
        row=s.get(Incident,event_id)
        if not row or (user=='integration' and row.status!='approved'):raise HTTPException(404,'Материал не найден')
        if kind.startswith('context-') and kind[8:].isdigit():
            index=int(kind[8:]);items=row.evidence.get('context_clips',[])
            if index>=len(items):raise HTTPException(404,'Материал не найден')
            item=items[index]
        elif kind in ('frame','clip'):item=row.evidence[kind]
        else:raise HTTPException(404,'Материал не найден')
        path=path_for(item['path'])
        if not path.is_file():raise HTTPException(410,'Материал недоступен')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise HTTPException(409,'Контрольная сумма материала не совпадает')
        return FileResponse(path,media_type='image/jpeg' if kind=='frame' else 'video/mp4',headers={'Cache-Control':'no-store','X-Content-SHA256':item['sha256']})
@app.get('/api/v2/audit')
def audit(user=Depends(manage)):
    with Session() as s:return [{k:getattr(a,k) for k in ('id','actor','action','entity','details','created')} for a in s.scalars(select(Audit).order_by(Audit.id.desc()).limit(200))]

@app.get('/api/v2/sources/{source_id}/preview')
def preview(source_id:str,user=Depends(view)):
    with Session() as s:
        if not s.get(Source,source_id):raise HTTPException(404,'Источник не найден')
    path=path_for(f'previews/{source_id}.jpg')
    if not path.is_file():raise HTTPException(404,'Первый кадр ещё не обработан')
    return FileResponse(path,media_type='image/jpeg',headers={'Cache-Control':'no-store'})
