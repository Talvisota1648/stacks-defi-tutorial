import os
import sys
from pathlib import Path

def main():
    path=Path(__file__).resolve().parents[2]/'.env'
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key,value=line.split('=',1);os.environ.setdefault(key.strip(),value.strip())
    role=sys.argv[1] if len(sys.argv)>1 else ''
    if role=='api':
        import uvicorn
        uvicorn.run('osc.api:app',host='127.0.0.1',port=8000)
    elif role=='worker':
        from .worker import main
        main()
    elif role=='collector':
        from .collector import main
        main()
    else:raise SystemExit('Usage: python -m osc.run api|worker|collector')
if __name__=='__main__':main()
