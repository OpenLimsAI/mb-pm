"""Store Agent business proposals and their confirmed execution receipts."""

import sqlalchemy as sa

from alembic import op

revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None


def upgrade():
    if sa.inspect(op.get_bind()).has_table("agent_proposals"):
        return
    op.create_table(
        "agent_proposals",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(64),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("draft", sa.JSON(), nullable=False),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("snapshot_digest", sa.String(64), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON()),
        sa.Column("error", sa.String(400)),
    )
    op.create_index(
        "ix_agent_proposals_actor_project", "agent_proposals", ["created_by", "project_id"]
    )


def downgrade():
    pass  # Retain pending reviews and audit receipts across an application rollback.
