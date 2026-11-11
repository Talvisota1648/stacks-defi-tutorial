import base64
import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlsplit
from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, Field, SecretStr
from .db import transaction, Session, Setting, LoginAttempt, Audit

COOKIE='osc_session'
def signature(payload):
    key=os.getenv('OSC_SESSION_KEY') or os.getenv('OSC_SETTINGS_KEY') or os.getenv('OSC_ADMIN_TOKEN','')
    if len(key)<24:raise HTTPException(503,'Не настроен серверный ключ сессии')
    return hmac.new(key.encode(),payload.encode(),hashlib.sha256).hexdigest()
def session_role(request):
    token=request.cookies.get(COOKIE,'')
    try:
        payload,mac=token.rsplit('.',1)
        if not hmac.compare_digest(signature(payload),mac):return None
        data=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
        if not isinstance(data,dict) or data.get('role') not in ('reviewer','admin') or data.get('expires',0)<time.time():return None
    except (ValueError,TypeError,UnicodeError):return None
    if data['role']=='reviewer' and data.get('revision','env')!=session_revision():return None
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin=request.headers.get('origin');host=request.headers.get('x-forwarded-host') or request.headers.get('host')
        if request.headers.get('sec-fetch-site')=='cross-site' or (origin and urlsplit(origin).netloc!=host):raise HTTPException(403,'Запрос должен быть с сайта приложения')
    return data['role']
class Login(BaseModel):
    username: str = Field(max_length=120)
    password: SecretStr = Field(max_length=300)

def login(body:Login,request:Request,response:Response):
    with Session() as s:
        configured_user=s.get(Setting,'presentation_username');configured_password=s.get(Setting,'presentation_password')
        from .settings import decrypt
        username=configured_user.value if configured_user else os.getenv('OSC_PRESENTATION_USERNAME','')
        password=decrypt(configured_password.value) if configured_password else os.getenv('OSC_PRESENTATION_PASSWORD','')
    if not username or len(password)<12:raise HTTPException(503,'Вход для презентации ещё не настроен администратором')
    host=request.client.host if request.client else 'unknown'
    bucket=hashlib.sha256(host.encode()).hexdigest();now=time.time()
    with transaction() as s:
        row=s.get(LoginAttempt,bucket)
        if not row:row=LoginAttempt(id=bucket,started=now,count=0);s.add(row)
        if now-row.started>60:row.started=now;row.count=0
        if row.count>=10:raise HTTPException(429,'Слишком много попыток. Повторите через минуту')
        row.count+=1
    valid=hmac.compare_digest(body.username.encode(),username.encode()) and hmac.compare_digest(body.password.get_secret_value().encode(),password.encode())
    if not valid:raise HTTPException(401,'Неверный логин или пароль')
    issue_session(response,request,'reviewer')
    with transaction() as s:s.add(Audit(actor=username,action='presentation_login',entity='session'))
    return {'role':'reviewer'}
def logout(response:Response):
    response.delete_cookie(COOKIE,path='/api/v2');return {'ok':True}

def issue_session(response,request,role):
    payload=base64.urlsafe_b64encode(json.dumps({'role':role,'expires':time.time()+28800,'revision':session_revision()}).encode()).decode().rstrip('=')
    response.set_cookie(COOKIE,payload+'.'+signature(payload),max_age=28800,httponly=True,secure=request.headers.get('x-forwarded-proto',request.url.scheme).split(',')[0].strip()=='https',samesite='strict',path='/api/v2')

class TokenLogin(BaseModel):
    token: SecretStr = Field(max_length=500)

def token_login(body:TokenLogin,request:Request,response:Response):
    for role in ('admin','reviewer'):
        expected=os.getenv('OSC_'+role.upper()+'_TOKEN','')
        if len(expected)>=24 and hmac.compare_digest(body.token.get_secret_value().encode(),expected.encode()):
            issue_session(response,request,role)
            return {'role':role}
    raise HTTPException(401,'Неверный токен')

def session_revision():
    with Session() as s:
        row=s.get(Setting,'presentation_revision')
        return row.value if row else 'env'
