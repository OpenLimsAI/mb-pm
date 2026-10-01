"""IAM 身份绑定与服务端会话（不改动任何业务表）

Revision ID: 003
Revises: 002
Create Date: 2026-09-27 00:00:00

新增 iam_identities / iam_sessions / iam_logins 三张表。应用启动时的
create_all 也会建这三张表，故本迁移按「表不存在才建」幂等执行。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "003"
down_revision: str | None = "002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "iam_identities" not in existing:
        op.create_table(
            "iam_identities",
            sa.Column("issuer", sa.String(255), primary_key=True),
            sa.Column("subject", sa.String(255), primary_key=True),
            sa.Column("user_id", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
            sa.UniqueConstraint("issuer", "user_id"),
        )
    if "iam_sessions" not in existing:
        op.create_table(
            "iam_sessions",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("tokens", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.BigInteger(), nullable=False),
        )
        op.create_index("ix_iam_sessions_expires_at", "iam_sessions", ["expires_at"])
    if "iam_logins" not in existing:
        op.create_table(
            "iam_logins",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("data", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.BigInteger(), nullable=False),
        )
        op.create_index("ix_iam_logins_expires_at", "iam_logins", ["expires_at"])


def downgrade() -> None:
    op.drop_table("iam_logins")
    op.drop_table("iam_sessions")
    op.drop_table("iam_identities")
