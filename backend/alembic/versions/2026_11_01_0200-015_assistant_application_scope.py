"""Keep bounded application-source lineage for permission-aware task history."""

import sqlalchemy as sa

from alembic import op

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade():
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("assistant_messages")
    }
    if "application_scope" not in columns:
        op.add_column(
            "assistant_messages",
            sa.Column("application_scope", sa.JSON(), nullable=False, server_default="{}"),
        )


def downgrade():
    with op.batch_alter_table("assistant_messages") as batch:
        batch.drop_column("application_scope")
