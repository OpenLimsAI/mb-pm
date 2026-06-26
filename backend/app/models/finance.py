"""ProjectFinance —— 项目预算 / 支出（组合预算聚合用）。"""

from sqlalchemy import JSON, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ProjectFinance(Base):
    __tablename__ = "project_finances"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    total_budget: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    spent: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    committed: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    # 成本结构：{ '人力': n, '设备': n, ... }
    breakdown: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    fiscal_year: Mapped[str | None] = mapped_column(String(20))
    notes: Mapped[str | None] = mapped_column(String(200))
