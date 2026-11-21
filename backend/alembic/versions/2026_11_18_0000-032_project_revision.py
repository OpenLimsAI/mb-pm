"""Protect project metadata and team drafts without rewriting business history."""

import sqlalchemy as sa

from alembic import op

revision = "032"
down_revision = "031"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if sa.inspect(bind).has_table("projects") and "revision" not in {
        column["name"] for column in sa.inspect(bind).get_columns("projects")
    }:
        op.add_column(
            "projects", sa.Column("revision", sa.Integer(), nullable=False, server_default="1")
        )


def downgrade():
    # An application rollback must retain revisions and subsequent writes.
    pass
