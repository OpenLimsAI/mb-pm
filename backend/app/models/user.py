"""User ORM 模型。"""

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(50), nullable=False)
    email: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)

    role: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    specialty_group: Mapped[str | None] = mapped_column(String(20))

    weekly_available_hours: Mapped[int] = mapped_column(Integer, default=40, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    avatar_color: Mapped[str | None] = mapped_column(String(20))

    # 演示模式无密码；生产环境请加 hashed_password
    hashed_password: Mapped[str | None] = mapped_column(String(120))

    # 关系
    owned_projects = relationship("Project", back_populates="owner", foreign_keys="Project.owner_id")
    project_memberships = relationship("ProjectMember", back_populates="user", cascade="all, delete-orphan")
    owned_tasks = relationship("Task", back_populates="owner", foreign_keys="Task.owner_id")
