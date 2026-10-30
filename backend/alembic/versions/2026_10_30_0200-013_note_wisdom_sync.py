"""Durable opt-in note projection. No legacy note migration."""

from alembic import op
from app.models.note import NoteWisdomSync

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade():
    NoteWisdomSync.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    NoteWisdomSync.__table__.drop(op.get_bind(), checkfirst=True)
