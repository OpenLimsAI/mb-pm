"""Explainable project progress; preserve execution values and policy data on rollback."""

import sqlalchemy as sa

from alembic import op

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "progress_method" not in {c["name"] for c in inspector.get_columns("projects")}:
        op.add_column(
            "projects",
            sa.Column("progress_method", sa.String(12), nullable=False, server_default="equal"),
        )
    if "progress_weight" not in {c["name"] for c in inspector.get_columns("tasks")}:
        op.add_column("tasks", sa.Column("progress_weight", sa.Numeric(10, 4), nullable=True))


def downgrade():
    # Keep policy settings; older images continue using their original progress calculation.
    pass
