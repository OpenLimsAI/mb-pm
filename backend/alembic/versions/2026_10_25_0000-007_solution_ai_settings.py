"""Encrypted private report model settings. Revision 007; replaces 006."""

import sqlalchemy as sa

from alembic import op

revision = "007_solution_ai"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade():
    if "solution_ai_settings" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "solution_ai_settings",
            sa.Column("issuer", sa.String(255), primary_key=True),
            sa.Column("owner_id", sa.String(255), primary_key=True),
            sa.Column("revision", sa.Integer, nullable=False),
            sa.Column("encrypted_payload", sa.Text, nullable=False),
        )


def downgrade():
    op.drop_table("solution_ai_settings")
