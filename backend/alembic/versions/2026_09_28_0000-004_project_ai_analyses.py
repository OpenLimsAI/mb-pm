"""项目 AI 分析记录

Revision ID: 004
Revises: 003
Create Date: 2026-09-28 00:00:00

新增 project_ai_analyses（每次项目 AI 分析的结果、所用模型与数据快照指纹）。
应用启动时的 create_all 也会建这张表，故本迁移按「表不存在才建」幂等执行。
AI 服务商设置不在数据库中，保存在后端本机文件（AI_SETTINGS_PATH）。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if "project_ai_analyses" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "project_ai_analyses",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(64),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
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
    op.create_index(
        "ix_project_ai_analyses_project_id", "project_ai_analyses", ["project_id"]
    )


def downgrade() -> None:
    op.drop_table("project_ai_analyses")
