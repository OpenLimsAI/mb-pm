"""Project schemas — 含 memberIds 团队字段。"""

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.business_values import DatedInput, Health, ProjectStatus, reject_null_fields
from app.schemas.finance import ProjectFinanceBase
from app.schemas.task import SubProjectCreate, TaskCreate, TaskDependencyCreate


class ProjectBase(DatedInput):
    code: str = Field(..., max_length=40)
    name: str = Field(..., max_length=200)
    product_type: str
    current_stage: str
    target_stage: str
    owner_id: str
    member_ids: list[str] = Field(default_factory=list, description="项目团队成员（可选）")
    status: ProjectStatus
    health: Health
    progress: int = Field(default=0, ge=0, le=100)
    planned_start: date
    planned_end: date
    template_id: str | None = None
    template_version: str | None = None
    description: str | None = None


class ProjectCreate(ProjectBase):
    id: str | None = None


class ProjectUpdate(DatedInput):
    name: str | None = None
    owner_id: str | None = None
    member_ids: list[str] | None = None
    status: ProjectStatus | None = None
    health: Health | None = None
    progress: int | None = Field(default=None, ge=0, le=100)
    planned_start: date | None = None
    planned_end: date | None = None
    description: str | None = None

    @model_validator(mode="after")
    def required_fields_not_null(self):
        return reject_null_fields(
            self,
            {"name", "owner_id", "status", "health", "progress", "planned_start", "planned_end"},
        )


class ProjectImportRequest(BaseModel):
    """整包创建：项目 + 子项目 + 任务 + 依赖。

    前端基于模板实例化后一次性写入（创建新项目）。
    """

    project: ProjectCreate
    sub_projects: list[SubProjectCreate] = Field(default_factory=list)
    tasks: list[TaskCreate] = Field(default_factory=list)
    dependencies: list[TaskDependencyCreate] = Field(default_factory=list)
    finance: ProjectFinanceBase | None = None


class ProjectCopyIn(BaseModel):
    """复制项目：以已有项目为蓝本新建（结构与计划照搬，执行数据重置）。"""

    code: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=200)
    owner_id: str | None = Field(default=None, max_length=64, description="缺省沿用原项目负责人")
    planned_start: date | None = Field(
        default=None, description="新项目计划开始；与原项目不同则全部计划日期按同样天数平移"
    )

    @field_validator("code", "name")
    @classmethod
    def _text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("不能为空")
        return value


class ProjectOut(ProjectBase):
    model_config = ConfigDict(from_attributes=True)
    id: str

    @classmethod
    def from_orm_with_members(cls, project) -> "ProjectOut":
        """从 SQLAlchemy 实例构造，自动展开 member_ids。"""
        return cls(
            id=project.id,
            code=project.code,
            name=project.name,
            product_type=project.product_type,
            current_stage=project.current_stage,
            target_stage=project.target_stage,
            owner_id=project.owner_id,
            member_ids=[m.user_id for m in project.members],
            status=project.status,
            health=project.health,
            progress=project.progress,
            planned_start=project.planned_start,
            planned_end=project.planned_end,
            template_id=project.template_id,
            template_version=project.template_version,
            description=project.description,
        )
