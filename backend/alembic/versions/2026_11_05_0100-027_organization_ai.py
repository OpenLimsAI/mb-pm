"""Add an encrypted organization model registry without touching personal rows."""

import sqlalchemy as sa

from alembic import op

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("organization_ai_settings"):
        op.create_table(
            "organization_ai_settings",
            sa.Column("issuer", sa.String(255), primary_key=True),
            sa.Column("organization", sa.String(255), primary_key=True),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column("encrypted_payload", sa.Text(), nullable=False),
        )


def downgrade():
    if sa.inspect(op.get_bind()).has_table("organization_ai_settings"):
        op.drop_table("organization_ai_settings")
