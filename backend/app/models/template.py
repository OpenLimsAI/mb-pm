"""Template + TemplateVersion。结构 JSON 直接存 JSONB。"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin


class Template(Base, TimestampMixin):
    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    product_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    current_version: Mapped[str] = mapped_column(String(20), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))

    versions = relationship(
        "TemplateVersion",
        back_populates="template",
        cascade="all, delete-orphan",
        order_by="TemplateVersion.modified_at.desc()",
    )


class TemplateVersion(Base):
    __tablename__ = "template_versions"

    id: Mapped[str] = mapped_column(String(30), primary_key=True)
    template_id: Mapped[str] = mapped_column(
        ForeignKey("templates.id", ondelete="CASCADE"), index=True
    )
    version_number: Mapped[str] = mapped_column(String(20), nullable=False)

    # 树形结构 JSON（TemplateNode 在 types.ts 里递归定义）；
    # 用 SQLAlchemy 通用 JSON 类型，SQLite/PostgreSQL 均可。
    structure_json: Mapped[dict] = mapped_column(JSON, nullable=False)

    change_summary: Mapped[str | None] = mapped_column(Text)
    change_source: Mapped[str] = mapped_column(String(20), nullable=False)  # visual_edit / excel_import
    modified_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    modified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    template = relationship("Template", back_populates="versions")


__all__ = ["Template", "TemplateVersion"]
