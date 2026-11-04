"""Optional feedback application; preserve unclassified history on rollback."""

import sqlalchemy as sa

from alembic import op

revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("feedback"):
        raise RuntimeError("feedback table must exist before migration 022")
    if "application" not in {column["name"] for column in inspector.get_columns("feedback")}:
        op.add_column("feedback", sa.Column("application", sa.String(32), nullable=True))


def downgrade():
    # Keep the classification and legacy NULL values when an older image is restored.
    pass
