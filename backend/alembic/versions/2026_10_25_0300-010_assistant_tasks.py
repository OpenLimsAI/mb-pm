"""Independent AI assistant tasks and private messages. Revision 010; replaces 009."""

import sqlalchemy as sa

from alembic import op

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if "assistant_tasks" not in sa.inspect(bind).get_table_names():
        op.create_table(
            "assistant_tasks",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("issuer", sa.String(255), nullable=False),
            sa.Column("owner_id", sa.String(255), nullable=False),
            sa.Column("title", sa.String(200), nullable=False),
            sa.Column("project", sa.String(200), nullable=False),
            sa.Column("instructions", sa.Text, nullable=False),
            sa.Column("revision", sa.Integer, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )
    if "ix_assistant_tasks_owner" not in {
        index["name"] for index in sa.inspect(bind).get_indexes("assistant_tasks")
    }:
        op.create_index(
            "ix_assistant_tasks_owner", "assistant_tasks", ["issuer", "owner_id", "updated_at"]
        )
    if "assistant_messages" not in sa.inspect(bind).get_table_names():
        op.create_table(
            "assistant_messages",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column(
                "task_id", sa.String(64), sa.ForeignKey("assistant_tasks.id"), nullable=False
            ),
            sa.Column("request_id", sa.String(64), nullable=False),
            sa.Column("position", sa.Integer, nullable=False),
            sa.Column("role", sa.String(20), nullable=False),
            sa.Column("content", sa.Text, nullable=False),
            sa.Column("context", sa.Text, nullable=False),
            sa.Column("profile_id", sa.String(100), nullable=True),
            sa.Column("model", sa.String(200), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint(
                "task_id", "request_id", "role", name="uq_assistant_messages_request_role"
            ),
            sa.UniqueConstraint("task_id", "position", name="uq_assistant_messages_position"),
        )
    if "ix_assistant_messages_task" not in {
        index["name"] for index in sa.inspect(bind).get_indexes("assistant_messages")
    }:
        op.create_index("ix_assistant_messages_task", "assistant_messages", ["task_id", "position"])


def downgrade():
    op.drop_table("assistant_messages")
    op.drop_table("assistant_tasks")
