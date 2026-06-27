"""Task / SubProject / TaskDependency schemas。"""

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


# ============= SubProject =============


class SubProjectBase(BaseModel):
    name: str = Field(..., max_length=200)
    project_id: str
    stage: str
    module: str
    owner_id: str | None = None
    status: str = "未开始"
    progress: int = 0
    sort_order: int = 0


class SubProjectCreate(SubProjectBase):
    id: str | None = None


class SubProjectUpdate(BaseModel):
    name: str | None = None
    stage: str | None = None
    module: str | None = None
    owner_id: str | None = None
    status: str | None = None
    progress: int | None = None
    sort_order: int | None = None


class SubProjectOut(SubProjectBase):
    model_config = ConfigDict(from_attributes=True)
    id: str


# ============= Task =============


class TaskBase(BaseModel):
    code: str = Field(..., max_length=50)
    name: str = Field(..., max_length=200)
    sub_project_id: str
    owner_id: str
    collaborator_ids: list[str] | None = None
    status: str = "未开始"
    priority: str = "中"
    planned_start: date
    planned_end: date
    actual_start: date | None = None
    actual_end: date | None = None
    estimated_effort: Decimal = Decimal(0)
    actual_effort: Decimal | None = None
    progress: int = 0
    is_milestone: bool = False
    is_critical_path: bool = False
    notes: str | None = None
    tags: list[str] | None = None


class TaskCreate(TaskBase):
    id: str | None = None


class TaskUpdate(BaseModel):
    """部分更新 — 全部字段可选。"""

    name: str | None = None
    owner_id: str | None = None
    collaborator_ids: list[str] | None = None
    status: str | None = None
    priority: str | None = None
    planned_start: date | None = None
    planned_end: date | None = None
    actual_start: date | None = None
    actual_end: date | None = None
    estimated_effort: Decimal | None = None
    actual_effort: Decimal | None = None
    progress: int | None = None
    is_milestone: bool | None = None
    is_critical_path: bool | None = None
    notes: str | None = None
    tags: list[str] | None = None


class TaskOut(TaskBase):
    model_config = ConfigDict(from_attributes=True)
    id: str


# ============= TaskDependency =============


class TaskDependencyBase(BaseModel):
    predecessor_id: str
    successor_id: str
    type: str = Field(..., pattern="^(FS|SS|FF|SF)$")
    lag_days: int = 0


class TaskDependencyCreate(TaskDependencyBase):
    id: str | None = None


class TaskDependencyOut(TaskDependencyBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
