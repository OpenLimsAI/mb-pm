"""Persist resumable project-assistant steps separately from final results."""

import sqlalchemy as sa

from alembic import op

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if sa.inspect(bind).has_table("pm_ai_runs") and "workflow" not in {
        column["name"] for column in sa.inspect(bind).get_columns("pm_ai_runs")
    }:
        op.add_column("pm_ai_runs", sa.Column("workflow", sa.JSON(), nullable=True))


def downgrade():
    # Retain nullable checkpoints so an application rollback cannot delete user work.
    pass
