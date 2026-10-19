import re
from typing import Literal
from pydantic import BaseModel, Field, model_validator

class Rule(BaseModel):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,60}$')
    type: Literal['vehicle_dwell', 'person_zone']
    polygon: list[tuple[float, float]] = Field(min_length=3, max_length=12)
    dwell_seconds: float = Field(default=15, ge=3, le=3600)
    cooldown_seconds: float = Field(default=120, ge=30, le=86400)
    @model_validator(mode='after')
    def polygon_valid(self):
        if any(not 0 <= v <= 1 for p in self.polygon for v in p): raise ValueError('Координаты зоны должны быть от 0 до 1')
        points = self.polygon
        area = abs(sum(points[i][0]*points[(i+1)%len(points)][1]-points[(i+1)%len(points)][0]*points[i][1] for i in range(len(points))))/2
        if area < 0.0001: raise ValueError('Зона должна иметь ненулевую площадь')
        return self
class SourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal['rtsp', 'upload']
    source_env: str = ''
    enabled: bool = False
    sample_fps: float = Field(default=0.5, ge=0.2, le=5)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    rules: list[Rule] = Field(default_factory=list, max_length=20)
    @model_validator(mode='after')
    def valid(self):
        if self.kind == 'rtsp' and not re.fullmatch(r'CAMERA_[A-Z0-9_]+_URL', self.source_env): raise ValueError('Нужно имя переменной CAMERA_01_URL, а не адрес или пароль камеры')
        if (self.latitude is None) != (self.longitude is None): raise ValueError('Нужны обе координаты')
        if len({r.id for r in self.rules}) != len(self.rules): raise ValueError('ID правил не должны повторяться')
        return self
class SourceUpdate(BaseModel):
    enabled: bool | None = None
    rules: list[Rule] | None = Field(default=None, max_length=20)
    sample_fps: float | None = Field(default=None, ge=0.2, le=5)
class Review(BaseModel):
    decision: Literal['approved','rejected']
    version: int = Field(ge=1)
    comment: str = Field(min_length=3, max_length=2000)
