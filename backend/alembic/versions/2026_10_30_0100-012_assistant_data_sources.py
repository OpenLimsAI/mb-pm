"""Record the data scope for assistant request replay."""

import sqlalchemy as sa

from alembic import op

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade():
    if "data_sources" not in {
        c["name"] for c in sa.inspect(op.get_bind()).get_columns("assistant_messages")
    }:
        op.add_column(
            "assistant_messages",
            sa.Column("data_sources", sa.String(100), nullable=False, server_default="[]"),
        )


def downgrade():
    with op.batch_alter_table("assistant_messages") as batch:
        batch.drop_column("data_sources")
