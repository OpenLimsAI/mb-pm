"""ProjectBaseline —— 项目计划基线快照（计划 vs 当前/版本对标）。

设立基线时按当时的项目计划日期、预算、里程碑计划日期等构建一份不可变快照，
之后即可对标「当前计划 vs 基线」的进度/成本偏移，并记录变更原因。
"""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ProjectBaseline(Base):
    __tablename__ = "project_baselines"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    # 快照：项目计划起止 / 预算 / 里程碑计划日期等（结构见 services 构建逻辑）
    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
