"""MDM idempotent creation and OIDC logout revocation. Revision 007."""

from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mdm_project_receipts",
        sa.Column("request_id", sa.String(36), primary_key=True),
        sa.Column("source_id", sa.String(64), nullable=False),
        sa.Column("source_project_id", sa.String(64), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column(
            "project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False, unique=True
        ),
        sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("source_id", "source_project_id", name="uq_mdm_source_project"),
    )
    op.create_table(
        "oidc_revocations",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("issuer", sa.String(255), nullable=False),
        sa.Column("audience", sa.String(255), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.Column("sid", sa.String(255), nullable=False),
        sa.Column("revoked_before", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "oidc_logout_replays",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
    )
    op.create_index("ix_oidc_logout_replays_expires_at", "oidc_logout_replays", ["expires_at"])


def downgrade():
    bind = op.get_bind()
    for table in ["mdm_project_receipts", "oidc_revocations", "oidc_logout_replays"]:
        if bind.dialect.name == "postgresql":
            bind.execute(sa.text("LOCK TABLE " + table + " IN ACCESS EXCLUSIVE MODE"))
        if bind.scalar(sa.text("SELECT count(*) FROM " + table)):
            raise RuntimeError(
                "Refusing to drop creation receipts or logout revocations; coordinate retention before rollback"
            )
    op.drop_index("ix_oidc_logout_replays_expires_at", table_name="oidc_logout_replays")
    op.drop_table("oidc_logout_replays")
    op.drop_table("oidc_revocations")
    op.drop_table("mdm_project_receipts")
