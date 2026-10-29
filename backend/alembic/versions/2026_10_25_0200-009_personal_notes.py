"""Independent portal personal notes. Revision 009; replaces 008."""

import sqlalchemy as sa

from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade():
    if "personal_notes" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "personal_notes",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("issuer", sa.String(255), nullable=False),
            sa.Column("owner_id", sa.String(255), nullable=False),
            sa.Column("title", sa.String(200), nullable=False),
            sa.Column("content", sa.Text, nullable=False),
            sa.Column("source_app", sa.String(30), nullable=False),
            sa.Column("source_title", sa.String(500), nullable=False),
            sa.Column("source_url", sa.String(2000), nullable=False),
            sa.Column("revision", sa.Integer, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )
    if "ix_personal_notes_owner" not in {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("personal_notes")
    }:
        op.create_index(
            "ix_personal_notes_owner", "personal_notes", ["issuer", "owner_id", "updated_at"]
        )


def downgrade():
    op.drop_table("personal_notes")
