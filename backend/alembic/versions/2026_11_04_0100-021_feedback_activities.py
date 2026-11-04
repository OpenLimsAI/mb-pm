"""Append-only feedback replies and handling history; retain records on rollback."""

import sqlalchemy as sa

from alembic import op

revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    # These two pre-existing features historically used Base.create_all. Freeze
    # their DDL here so a fresh Alembic-only installation can resolve the FK too.
    if "feedback" not in tables:
        op.create_table(
            "feedback",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("issuer", sa.String(255), nullable=False),
            sa.Column("author_id", sa.String(255), nullable=False),
            sa.Column("author_name", sa.String(255), nullable=False),
            sa.Column("category", sa.String(20), nullable=False),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_feedback_issuer", "feedback", ["issuer"])
    if "feedback_images" not in tables:
        op.create_table(
            "feedback_images",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column(
                "feedback_id",
                sa.String(32),
                sa.ForeignKey("feedback.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("content_type", sa.String(30), nullable=False),
            sa.Column("content", sa.LargeBinary(), nullable=False),
        )
        op.create_index("ix_feedback_images_feedback_id", "feedback_images", ["feedback_id"])
    if "feedback_activities" not in tables:
        op.create_table(
            "feedback_activities",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column(
                "feedback_id",
                sa.String(32),
                sa.ForeignKey("feedback.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("author_id", sa.String(255), nullable=False),
            sa.Column("author_name", sa.String(255), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("from_status", sa.String(20)),
            sa.Column("to_status", sa.String(20)),
            sa.Column("client_request_id", sa.String(64)),
            sa.Column("request_hash", sa.String(64)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint(
                "feedback_id", "client_request_id", name="uq_feedback_activity_request"
            ),
        )
        op.create_index(
            "ix_feedback_activities_feedback_id", "feedback_activities", ["feedback_id"]
        )
        op.create_index("ix_feedback_activities_created_at", "feedback_activities", ["created_at"])


def downgrade():
    # Replies and repair explanations are user data. Older application images ignore
    # this additive table; an application rollback must not erase the conversation.
    pass
