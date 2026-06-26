"""Project schemas — 含 memberIds 团队字段。"""

from datetime import date

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.finance import ProjectFinanceBase
from app.schemas.task import SubProjectCreate, TaskCreate, TaskDependencyCreate


class ProjectBase(BaseModel):
    code: str = Field(..., max_length=40)
    name: str = Field(..., max_length=200)
    product_type: str
    current_stage: str
    target_stage: str
    owner_id: str
    member_ids: list[str] = Field(default_factory=list, description="项目团队成员（可选）")
    status: str
    health: str
    progress: int = 0
    planned_start: date
    planned_end: date
    template_id: str | None = None
    template_version: str | None = None
    description: str | None = None


class ProjectCreate(ProjectBase):
    id: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    owner_id: str | None = None
    member_ids: list[str] | None = None
    status: str | None = None
    health: str | None = None
    progress: int | None = None
    planned_start: date | None = None
    planned_end: date | None = None
    description: str | None = None


class ProjectImportRequest(BaseModel):
    """整包创建：项目 + 子项目 + 任务 + 依赖。

    前端基于模板实例化后一次性写入（创建新项目）。
    """

    project: ProjectCreate
    sub_projects: list[SubProjectCreate] = Field(default_factory=list)
    tasks: list[TaskCreate] = Field(default_factory=list)
    dependencies: list[TaskDependencyCreate] = Field(default_factory=list)
    finance: ProjectFinanceBase | None = None


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
