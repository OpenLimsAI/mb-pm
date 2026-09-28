"""财务 AI 分析记录

Revision ID: 005
Revises: 004
Create Date: 2026-09-28 01:00:00

新增 finance_ai_analyses（组合财务 AI 分析的结果、所用模型与数据快照指纹）。
应用启动时的 create_all 也会建这张表，故本迁移按「表不存在才建」幂等执行。
项目「已花费」改为由任务实际花费实时汇总，project_finances.spent 列保留但不再使用，无需迁移。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if "finance_ai_analyses" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "finance_ai_analyses",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("model", sa.String(160), nullable=False),
        sa.Column("focus", sa.Text(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False, server_default=""),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source", sa.JSON(), nullable=False),
        sa.Column("usage", sa.JSON(), nullable=False),
    )
    op.create_index("ix_finance_ai_analyses_created_at", "finance_ai_analyses", ["created_at"])


def downgrade() -> None:
    op.drop_table("finance_ai_analyses")
