"""Project + ProjectMember（团队多对多关联表）。"""

from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, PrimaryKeyConstraint, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin
from app.db.business_constraints import table_constraints


class Project(Base, TimestampMixin):
    __tablename__ = "projects"
    __table_args__ = table_constraints("projects")

    # 前端生成的项目 ID 及其派生的组合 ID 较长，统一用 64（issue #4）。
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    product_type: Mapped[str] = mapped_column(String(20), nullable=False)
    current_stage: Mapped[str] = mapped_column(String(20), nullable=False)
    target_stage: Mapped[str] = mapped_column(String(20), nullable=False)

    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)

    status: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    health: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    planned_start: Mapped[date] = mapped_column(Date, nullable=False)
    planned_end: Mapped[date] = mapped_column(Date, nullable=False)

    template_id: Mapped[str | None] = mapped_column(ForeignKey("templates.id"))
    template_version: Mapped[str | None] = mapped_column(String(20))

    description: Mapped[str | None] = mapped_column(Text)

    # 关系
    owner = relationship("User", back_populates="owned_projects", foreign_keys=[owner_id])
    members = relationship("ProjectMember", back_populates="project", cascade="all, delete-orphan")
    sub_projects = relationship(
        "SubProject", back_populates="project", cascade="all, delete-orphan"
    )
    template = relationship("Template")


class ProjectMember(Base):
    """项目团队成员（多对多 — Project ↔ User）。"""

    __tablename__ = "project_members"
    __table_args__ = (PrimaryKeyConstraint("project_id", "user_id", name="pk_project_members"),)

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))

    project = relationship("Project", back_populates="members")
    user = relationship("User", back_populates="project_memberships")
