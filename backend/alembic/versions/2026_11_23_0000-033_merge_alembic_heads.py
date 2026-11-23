"""Merge branched Alembic heads ('007', '032') into a single linear head."""

revision = "033"
down_revision = ("007", "032")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
