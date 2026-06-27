"""SubProject + Task + TaskDependency。"""

from datetime import date
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin


class SubProject(Base, TimestampMixin):
    """Level 2: 子项目（按阶段+模块切分）。"""

    __tablename__ = "sub_projects"

    # 组合 ID `${projectId}-${子项目code}` 可达 ~24 字符，故用 64（issue #4）。
    # FK 列（project_id 等）未显式声明类型，自动继承所引用主键的宽度。
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )

    stage: Mapped[str] = mapped_column(String(20), nullable=False)
    module: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    project = relationship("Project", back_populates="sub_projects")
    tasks = relationship("Task", back_populates="sub_project", cascade="all, delete-orphan")


class Task(Base, TimestampMixin):
    """Level 3: 任务（叶子节点）。三级 WBS 强约束。"""

    __tablename__ = "tasks"

    # 组合 ID `${projectId}-${taskCode}` 可达 ~30 字符，故用 64（issue #4）。
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    sub_project_id: Mapped[str] = mapped_column(
        ForeignKey("sub_projects.id", ondelete="CASCADE"), index=True
    )
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    collaborator_ids: Mapped[list[str] | None] = mapped_column(JSON)

    status: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    priority: Mapped[str] = mapped_column(String(10), nullable=False)

    planned_start: Mapped[date] = mapped_column(Date, nullable=False)
    planned_end: Mapped[date] = mapped_column(Date, nullable=False)
    actual_start: Mapped[date | None] = mapped_column(Date)
    actual_end: Mapped[date | None] = mapped_column(Date)

    estimated_effort: Mapped[Decimal] = mapped_column(Numeric(6, 2), default=0)
    actual_effort: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))

    # 成本预算（万元 RMB，含外包/耗材/CRO，不含内部人力）—— 源自模板 costBudget
    cost_budget: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    # 实际花费（万元 RMB）—— 任务执行过程中录入，与 cost_budget 对比
    actual_cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))

    progress: Mapped[int] = mapped_column(Integer, default=0)
    is_milestone: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_critical_path: Mapped[bool] = mapped_column(Boolean, default=False)

    notes: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list[str] | None] = mapped_column(JSON)

    sub_project = relationship("SubProject", back_populates="tasks")
    owner = relationship("User", back_populates="owned_tasks", foreign_keys=[owner_id])

    successors = relationship(
        "TaskDependency",
        back_populates="predecessor",
        foreign_keys="TaskDependency.predecessor_id",
        cascade="all, delete-orphan",
    )
    predecessors = relationship(
        "TaskDependency",
        back_populates="successor",
        foreign_keys="TaskDependency.successor_id",
        cascade="all, delete-orphan",
    )


class TaskDependency(Base):
    """任务依赖（FS/SS/FF/SF + lag）。"""

    __tablename__ = "task_dependencies"

    # 组合 ID `${projectId}-dep-${n}`；与任务 ID 保持同宽 64（issue #4）。
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    predecessor_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    successor_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(2), nullable=False)
    lag_days: Mapped[int] = mapped_column(Integer, default=0)

    predecessor = relationship("Task", back_populates="successors", foreign_keys=[predecessor_id])
    successor = relationship("Task", back_populates="predecessors", foreign_keys=[successor_id])
