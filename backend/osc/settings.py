import base64
import hashlib
import os
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from .db import Session, Setting

def cipher():
    secret=os.getenv('OSC_SETTINGS_KEY') or os.getenv('OSC_ADMIN_TOKEN','')
    if len(secret)<24:raise HTTPException(503,'Не настроен серверный ключ хранения настроек')
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))
def encrypt(value):return cipher().encrypt(value.encode()).decode()
def decrypt(value):
    try:return cipher().decrypt(value.encode()).decode()
    except InvalidToken:raise RuntimeError('Cannot decrypt settings; restore server settings key') from None

def openrouter_settings():
    with Session() as s:
        key=s.get(Setting,'openrouter_key');model=s.get(Setting,'openrouter_model')
        return ((decrypt(key.value) if key.value else '') if key else os.getenv('OPENROUTER_API_KEY',''),model.value if model else os.getenv('OPENROUTER_MODEL','google/gemini-3.8-flash'))
