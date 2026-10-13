"""项目结构编辑（编辑模式「统一保存」）的请求体。

前端提交编辑后的完整结构：子项目（有序）→ 任务；已有对象带 id，新建对象只有 key。
前置依赖用任务的 id 或 key 引用；后端与当前库比对后在一个事务里增删改。
"""

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator


def _text(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("不能为空")
    return value


class StructureTaskIn(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    key: str = Field(min_length=1, max_length=80)
    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=200)
    is_milestone: bool = False
    owner_id: str = Field(min_length=1, max_length=64)
    planned_start: date
    planned_end: date
    estimated_effort: Decimal = Field(default=Decimal(0), ge=0, le=100000)
    cost_budget: Decimal | None = Field(default=None, ge=0, le=99_999_999)
    notes: str | None = Field(default=None, max_length=2000)
    predecessors: list[str] = Field(default_factory=list, max_length=200)

    @field_validator("code", "name")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return _text(value)


class StructureSubIn(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    key: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    module: str = Field(min_length=1, max_length=20)
    stage: str = Field(min_length=1, max_length=20)
    tasks: list[StructureTaskIn] = Field(default_factory=list, max_length=2000)

    @field_validator("name", "module", "stage")
    @classmethod
    def _required_text(cls, value: str) -> str:
        return _text(value)


class StructureSaveIn(BaseModel):
    # 进入编辑模式时读到的结构版本；保存时与当前库比对，防止覆盖他人的修改
    version: str = Field(min_length=64, max_length=64)
    summary: str | None = Field(default=None, max_length=200)
    sub_projects: list[StructureSubIn] = Field(max_length=200)
