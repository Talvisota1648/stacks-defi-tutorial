"""Small Linux/RunPod process controller. Does not operate on unrelated services."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from .run import load_env

ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'.run'/'processes.json'
def identity(pid):
    try:
        fields=Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()
        return fields[19] if fields[0]!='Z' else None
    except (OSError,IndexError):return None

def application_process(cwd,args):
    if not args:return False
    backend=cwd==ROOT/'backend' and any(args[i:i+3] in (['-m','osc.run','api'],['-m','osc.run','worker'],['-m','osc.run','collector']) for i in range(len(args)-2))
    next_command='start' in args and any(Path(a).name=='next' or '/next/dist/bin/next' in a for a in args)
    web=cwd==ROOT/'frontend' and (args[0].startswith(('npm run start','next-server')) or next_command)
    return backend or web

def legacy_processes():
    found=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name)==os.getpid():continue
        try:
            cwd=(p/'cwd').resolve();args=(p/'cmdline').read_bytes().decode().split('\0')
            if application_process(cwd,args):found.append((int(p.name),identity(int(p.name))))
        except (OSError,UnicodeError):pass
    return found

def require_free_port(host,port):
    try:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            probe.bind((host,int(port)))
    except OSError:raise SystemExit(f'Port {port} is already occupied. No new services started. Use restart --replace for this application, or choose a free OSC_WEB_PORT.') from None

def stop(replace=False):
    managed=json.loads(STATE.read_text()) if STATE.exists() else {}
    for info in managed.values():
        if identity(info['pid'])==info['start']:
            try:os.killpg(info['pid'],signal.SIGTERM)
            except ProcessLookupError:pass
    if replace:
        for pid,start in legacy_processes():
            if start and identity(pid)==start:
                try:os.kill(pid,signal.SIGTERM)
                except ProcessLookupError:pass
    for _ in range(50):
        active=[i for i in managed.values() if identity(i['pid'])==i['start']]
        if not active and (not replace or not legacy_processes()):break
        time.sleep(.2)
    else:raise SystemExit('An old application process did not stop. Check its log before retrying.')
    STATE.unlink(missing_ok=True)

def start(public=False,replace=False):
    if replace:stop(True)
    elif STATE.exists() and any(identity(i['pid'])==i['start'] for i in json.loads(STATE.read_text()).values()):raise SystemExit('Application already running; use restart.')
    if public and (not os.getenv('OSC_PRESENTATION_USERNAME') or len(os.getenv('OSC_PRESENTATION_PASSWORD',''))<12):raise SystemExit('Run node scripts/presentation-access.cjs first.')
    if not (ROOT/'frontend'/'.next'/'BUILD_ID').is_file():raise SystemExit('Build frontend first: npm ci && npm run build')
    env=os.environ.copy();api_port=env.get('OSC_API_PORT','8000');web_port=env.get('OSC_WEB_PORT','3000')
    require_free_port('127.0.0.1',api_port)
    require_free_port('0.0.0.0' if public else '127.0.0.1',web_port)
    env['OSC_BACKEND_URL']=f'http://127.0.0.1:{api_port}';env['NEXT_TELEMETRY_DISABLED']='1';env.setdefault('NODE_OPTIONS','--max-old-space-size=768')
    manifest={};logs=ROOT/'logs';logs.mkdir(exist_ok=True);STATE.parent.mkdir(exist_ok=True)
    try:
        for name in ('api','worker','collector','web'):
            command=[sys.executable,'-m','osc.run',name] if name!='web' else ['npm','run','start','--','--hostname','0.0.0.0' if public else '127.0.0.1','--port',web_port]
            with (logs/f'{name}.log').open('ab') as log:
                child=subprocess.Popen(command,cwd=ROOT/('frontend' if name=='web' else 'backend'),env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            manifest[name]={'pid':child.pid,'start':identity(child.pid)};STATE.write_text(json.dumps(manifest));STATE.chmod(0o600)
            if name in ('api','web'):
                url=f'http://127.0.0.1:{api_port}/health' if name=='api' else f'http://127.0.0.1:{web_port}'
                for _ in range(60):
                    if child.poll() is not None:raise RuntimeError(f'{name} exited; see logs/{name}.log')
                    try:
                        with urllib.request.urlopen(url,timeout=1) as r:
                            if r.status==200:break
                    except Exception:time.sleep(.5)
                else:raise RuntimeError(f'{name} health check failed')
        print('API and web respond. Background services started; local model readiness is visible on the dashboard.')
        if public:print('RunPod: expose HTTP port '+web_port+' and use its HTTPS link from Connect. Backend port remains private.')
    except BaseException:stop();raise

def main():
    load_env();p=argparse.ArgumentParser();p.add_argument('action',choices=['start','stop','restart','status']);p.add_argument('--public',action='store_true');p.add_argument('--replace',action='store_true');args=p.parse_args()
    if args.action=='status':
        data=json.loads(STATE.read_text()) if STATE.exists() else {};print(json.dumps({k:identity(v['pid'])==v['start'] for k,v in data.items()}));return
    if args.action=='stop':stop(args.replace)
    elif args.action=='restart':stop(args.replace);start(args.public)
    else:start(args.public,args.replace)
if __name__=='__main__':main()
