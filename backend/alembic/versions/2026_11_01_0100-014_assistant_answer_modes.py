"""Add persisted answer routing and public-search provenance, preserving old rows."""

import sqlalchemy as sa

from alembic import op

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade():
    for table in ("assistant_messages", "solution_answers"):
        columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}
        for name, size in (("answer_mode", 20), ("requested_mode", 20), ("mode_reason", 200)):
            if name not in columns:
                op.add_column(
                    table, sa.Column(name, sa.String(size), nullable=False, server_default="")
                )
        if "web_references" not in columns:
            op.add_column(
                table, sa.Column("web_references", sa.JSON(), nullable=False, server_default="[]")
            )


def downgrade():
    for table in ("assistant_messages", "solution_answers"):
        with op.batch_alter_table(table) as batch:
            for name in ("web_references", "mode_reason", "requested_mode", "answer_mode"):
                batch.drop_column(name)
