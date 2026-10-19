import os
import tempfile
from pathlib import Path
import pytest

os.environ['OSC_DATA_DIR']=tempfile.mkdtemp(prefix='osc-tests-')
os.environ['OSC_DATABASE_URL']='sqlite:///'+str(Path(os.environ['OSC_DATA_DIR'])/'test.db')
for role in ('ADMIN','REVIEWER','INTEGRATION','INGEST'):os.environ[f'OSC_{role}_TOKEN']=f'test-{role.lower()}-token-for-unit-tests-0001'
from osc import db
from osc.api import app
from fastapi.testclient import TestClient

@pytest.fixture(autouse=True)
def reset():
    db.init_db()
    with db.transaction() as s:
        for table in reversed(db.Base.metadata.sorted_tables):
            if table.name!='mutex':s.execute(table.delete())
    yield
@pytest.fixture
def client():
    with TestClient(app) as client:yield client
@pytest.fixture
def headers():return {'Authorization':'Bearer '+os.environ['OSC_ADMIN_TOKEN']}
