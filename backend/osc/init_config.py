import secrets
from pathlib import Path

def main():
    path=Path(__file__).resolve().parents[2]/'.env'
    if path.exists():raise SystemExit('Existing .env preserved; edit it manually if necessary')
    values={f'OSC_{role}_TOKEN':secrets.token_urlsafe(32) for role in ('ADMIN','REVIEWER','INGEST','INTEGRATION')}
    values.update(OSC_DB_PASSWORD=secrets.token_urlsafe(32),OSC_REVIEWER_NAME='Специалист',CAMERA_01_URL='',OSC_MAX_QUEUE='300',OSC_MIN_FREE_MB='512',OSC_UNEVENTFUL_RETENTION_HOURS='24')
    path.write_text('\n'.join(f'{k}={v}' for k,v in values.items())+'\n');path.chmod(0o600)
    print(f'Created {path}. Access tokens are stored there; do not commit or send them to chat.')
if __name__=='__main__':main()
