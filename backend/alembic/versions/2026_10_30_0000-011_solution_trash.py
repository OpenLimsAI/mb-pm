"""Recoverable report deletion; preserve report data and history."""

import sqlalchemy as sa
from alembic import op

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "deleted_at" not in {c["name"] for c in inspector.get_columns("knowledge_solutions")}:
        op.add_column(
            "knowledge_solutions",
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade():
    bind = op.get_bind()
    if bind.scalar(
        sa.text("SELECT COUNT(*) FROM knowledge_solutions WHERE deleted_at IS NOT NULL")
    ):
        raise RuntimeError("Cannot downgrade while reports are in the recycle bin")
    with op.batch_alter_table("knowledge_solutions") as batch:
        batch.drop_column("deleted_at")
