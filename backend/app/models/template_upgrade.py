"""Explicit template provenance for selectively upgraded live projects."""

from sqlalchemy import JSON, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class ProjectTemplateState(Base, TimestampMixin):
    __tablename__ = "project_template_states"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    task_mapping: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    sub_mapping: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    removed_nodes: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
