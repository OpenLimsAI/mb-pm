"""Persist cross-project AI runs and confirmed changes."""

import sqlalchemy as sa

from alembic import op

revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def upgrade():
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "pm_ai_runs" not in tables:
        op.create_table(
            "pm_ai_runs",
            sa.Column("id", sa.String(40), primary_key=True),
            sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True)),
            sa.Column("finished_at", sa.DateTime(timezone=True)),
            sa.Column("state", sa.String(16), nullable=False),
            sa.Column("request", sa.JSON(), nullable=False),
            sa.Column("context", sa.JSON(), nullable=False),
            sa.Column("source", sa.JSON(), nullable=False),
            sa.Column("result", sa.JSON()),
            sa.Column("provider", sa.String(20)),
            sa.Column("model", sa.String(160)),
            sa.Column("usage", sa.JSON(), nullable=False),
            sa.Column("error", sa.Text(), nullable=False),
            sa.Column("claim", sa.String(40)),
        )
        for field in ("created_by", "state"):
            op.create_index(f"ix_pm_ai_runs_{field}", "pm_ai_runs", [field])
    if "pm_ai_change_receipts" not in tables:
        op.create_table(
            "pm_ai_change_receipts",
            sa.Column("id", sa.String(40), primary_key=True),
            sa.Column(
                "run_id",
                sa.String(40),
                sa.ForeignKey("pm_ai_runs.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("request_fingerprint", sa.String(64), nullable=False),
            sa.Column("actions", sa.JSON(), nullable=False),
            sa.Column("result", sa.JSON(), nullable=False),
        )
        for field in ("run_id", "created_by"):
            op.create_index(f"ix_pm_ai_change_receipts_{field}", "pm_ai_change_receipts", [field])


def downgrade():
    # Keep analysis and accepted-change evidence available during an image rollback.
    pass
