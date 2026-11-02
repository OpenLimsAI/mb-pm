"""ProjectFinance —— 项目级预算（组合预算聚合用），一个项目一条。

总预算 / 已承诺 / 成本结构 / 财年 / 备注由管理员或 CMC 负责人维护（PUT /finances/{project_id}）。
「已花费」不再手工维护：对外一律由该项目全部任务的实际花费实时汇总（services/finance.py），
表中的 spent 列仅为兼容旧库保留，不再读写。
"""

from sqlalchemy import JSON, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.business_constraints import table_constraints


class ProjectFinance(Base):
    __tablename__ = "project_finances"
    __table_args__ = table_constraints("project_finances")

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    total_budget: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    # 历史字段：已花费改为实时汇总，此列不再使用
    spent: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    committed: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    # 成本结构：{ '人力': n, '设备': n, ... }
    breakdown: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    fiscal_year: Mapped[str | None] = mapped_column(String(20))
    notes: Mapped[str | None] = mapped_column(String(200))
