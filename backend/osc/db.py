import os
import time
from pathlib import Path
from contextlib import contextmanager
from sqlalchemy import create_engine, event, String, Float, Integer, JSON, Text, UniqueConstraint, ForeignKey
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATA = Path(os.getenv('OSC_DATA_DIR', 'data')).resolve()
DATA.mkdir(parents=True, exist_ok=True)
engine = create_engine(os.getenv('OSC_DATABASE_URL', f'sqlite:///{DATA / "osc.db"}'), connect_args={'timeout': 30, 'check_same_thread': False} if os.getenv('OSC_DATABASE_URL', 'sqlite').startswith('sqlite') else {}, pool_pre_ping=True)
if engine.dialect.name == 'sqlite':
    @event.listens_for(engine, 'connect')
    def sqlite_setup(connection, _):
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA foreign_keys=ON')
Session = sessionmaker(engine, expire_on_commit=False)
class Base(DeclarativeBase): pass
class Mutex(Base):
    __tablename__ = 'mutex'
    id: Mapped[int] = mapped_column(primary_key=True)
class Source(Base):
    __tablename__ = 'sources'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(12))
    source_env: Mapped[str] = mapped_column(String(100), default='')
    enabled: Mapped[bool] = mapped_column(default=False)
    sample_fps: Mapped[float] = mapped_column(Float, default=0.5)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    rules: Mapped[list] = mapped_column(JSON, default=list)
    rule_state: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(40), default='disabled')
    last_frame: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str] = mapped_column(String(300), default='')
    collector_owner: Mapped[str] = mapped_column(String(80), default='')
    collector_lease: Mapped[float] = mapped_column(Float, default=0)
    worker_owner: Mapped[str] = mapped_column(String(80), default='')
    worker_lease: Mapped[float] = mapped_column(Float, default=0)
    created: Mapped[float] = mapped_column(Float, default=time.time)
class Job(Base):
    __tablename__ = 'jobs'
    __table_args__ = (UniqueConstraint('source_id', 'ingest_key'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey('sources.id'))
    path: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    ingest_key: Mapped[str] = mapped_column(String(120))
    captured_at: Mapped[float] = mapped_column(Float)
    location: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default='queued')
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    owner: Mapped[str] = mapped_column(String(80), default='')
    lease: Mapped[float] = mapped_column(Float, default=0)
    error: Mapped[str] = mapped_column(String(300), default='')
    created: Mapped[float] = mapped_column(Float, default=time.time)
class Incident(Base):
    __tablename__ = 'incidents'
    __table_args__ = (UniqueConstraint('job_id', 'rule_id', 'track_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey('sources.id'))
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'))
    rule_id: Mapped[str] = mapped_column(String(80))
    track_id: Mapped[str] = mapped_column(String(36))
    category: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text)
    detected_at: Mapped[float] = mapped_column(Float)
    evidence: Mapped[dict] = mapped_column(JSON)
    location: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(12), default='pending')
    version: Mapped[int] = mapped_column(Integer, default=1)
    reviewer: Mapped[str] = mapped_column(String(120), default='')
    comment: Mapped[str] = mapped_column(Text, default='')
    reviewed_at: Mapped[float | None] = mapped_column(Float, nullable=True)
class EvidenceLink(Base):
    __tablename__ = 'evidence_links'
    incident_id: Mapped[str] = mapped_column(ForeignKey('incidents.id'), primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'), primary_key=True)

class Outbox(Base):
    __tablename__ = 'outbox'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    incident_id: Mapped[str] = mapped_column(ForeignKey('incidents.id'), unique=True)
    created: Mapped[float] = mapped_column(Float, default=time.time)
class Audit(Base):
    __tablename__ = 'audit'
    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(80))
    entity: Mapped[str] = mapped_column(String(80))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created: Mapped[float] = mapped_column(Float, default=time.time)
class Heartbeat(Base):
    __tablename__ = 'heartbeats'
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    role: Mapped[str] = mapped_column(String(20))
    seen: Mapped[float] = mapped_column(Float)
    details: Mapped[dict] = mapped_column(JSON, default=dict)

def init_db():
    Base.metadata.create_all(engine)
    with Session.begin() as s:
        if not s.get(Mutex, 1): s.add(Mutex(id=1))

@contextmanager
def transaction():
    with Session() as session:
        try:
            if engine.dialect.name == 'sqlite': session.connection().exec_driver_sql('BEGIN IMMEDIATE')
            else: session.query(Mutex).filter_by(id=1).with_for_update().one()
            yield session
            session.commit()
        except BaseException:
            session.rollback()
            raise

def heartbeat(owner, role, details):
    with transaction() as s:
        row = s.get(Heartbeat, owner)
        if not row: row = Heartbeat(id=owner, role=role); s.add(row)
        row.seen = time.time(); row.details = details

def path_for(relative):
    path = (DATA / relative).resolve()
    if not path.is_relative_to(DATA): raise ValueError('Invalid evidence path')
    return path
