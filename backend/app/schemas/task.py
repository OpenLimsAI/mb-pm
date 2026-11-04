"""Task / SubProject / TaskDependency schemas。"""

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.business_values import (
    MAX_COST,
    MAX_EFFORT,
    DatedInput,
    Priority,
    TaskStatus,
    reject_null_fields,
)

# ============= SubProject =============


class SubProjectBase(BaseModel):
    name: str = Field(..., max_length=200)
    project_id: str
    stage: str
    module: str
    owner_id: str | None = None
    status: TaskStatus = "未开始"
    progress: int = Field(default=0, ge=0, le=100)
    sort_order: int = 0


class SubProjectCreate(SubProjectBase):
    id: str | None = None


class SubProjectUpdate(BaseModel):
    name: str | None = None
    stage: str | None = None
    module: str | None = None
    owner_id: str | None = None
    status: TaskStatus | None = None
    progress: int | None = Field(default=None, ge=0, le=100)
    sort_order: int | None = None

    @model_validator(mode="after")
    def required_fields_not_null(self):
        return reject_null_fields(
            self, {"name", "stage", "module", "status", "progress", "sort_order"}
        )


class SubProjectOut(SubProjectBase):
    model_config = ConfigDict(from_attributes=True)
    id: str


# ============= Task =============


class TaskBase(DatedInput):
    code: str = Field(..., max_length=50)
    name: str = Field(..., max_length=200)
    sub_project_id: str
    owner_id: str
    collaborator_ids: list[str] | None = None
    status: TaskStatus = "未开始"
    priority: Priority = "中"
    planned_start: date
    planned_end: date
    actual_start: date | None = None
    actual_end: date | None = None
    estimated_effort: Decimal = Field(default=Decimal(0), ge=0, le=MAX_EFFORT, allow_inf_nan=False)
    actual_effort: Decimal | None = Field(default=None, ge=0, le=MAX_EFFORT, allow_inf_nan=False)
    cost_budget: Decimal | None = Field(default=None, ge=0, le=MAX_COST, allow_inf_nan=False)
    actual_cost: Decimal | None = Field(default=None, ge=0, le=MAX_COST, allow_inf_nan=False)
    progress: int = Field(default=0, ge=0, le=100)
    is_milestone: bool = False
    is_critical_path: bool = False
    notes: str | None = None
    tags: list[str] | None = None
    # 子项目内的手动顺序；创建时不填则接在末尾（子项目尚未排序时保持空值，按日期排列）
    sort_order: int | None = None


class TaskCreate(TaskBase):
    id: str | None = None


class TaskUpdate(DatedInput):
    """部分更新 — 全部字段可选。"""

    expected_revision: int | None = Field(default=None, ge=1)
    progress_note: str | None = Field(default=None, max_length=5000)
    name: str | None = None
    owner_id: str | None = None
    collaborator_ids: list[str] | None = None
    status: TaskStatus | None = None
    priority: Priority | None = None
    planned_start: date | None = None
    planned_end: date | None = None
    actual_start: date | None = None
    actual_end: date | None = None
    estimated_effort: Decimal | None = Field(default=None, ge=0, le=MAX_EFFORT, allow_inf_nan=False)
    actual_effort: Decimal | None = Field(default=None, ge=0, le=MAX_EFFORT, allow_inf_nan=False)
    cost_budget: Decimal | None = Field(default=None, ge=0, le=MAX_COST, allow_inf_nan=False)
    actual_cost: Decimal | None = Field(default=None, ge=0, le=MAX_COST, allow_inf_nan=False)
    progress: int | None = Field(default=None, ge=0, le=100)
    is_milestone: bool | None = None
    is_critical_path: bool | None = None
    notes: str | None = None
    tags: list[str] | None = None

    @model_validator(mode="after")
    def required_fields_not_null(self):
        return reject_null_fields(
            self,
            {
                "name",
                "owner_id",
                "status",
                "priority",
                "planned_start",
                "planned_end",
                "estimated_effort",
                "progress",
                "is_milestone",
                "is_critical_path",
            },
        )


class TaskOut(TaskBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    revision: int = 1


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
