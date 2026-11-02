"""Durable owned assistant requests and a fenced per-task generation slot."""

import sqlalchemy as sa
from alembic import op

revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("assistant_tasks")}
    if "active_request_id" not in columns:
        op.add_column(
            "assistant_tasks", sa.Column("active_request_id", sa.String(64), nullable=True)
        )
    if "assistant_requests" not in sa.inspect(bind).get_table_names():
        op.create_table(
            "assistant_requests",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column(
                "task_id", sa.String(64), sa.ForeignKey("assistant_tasks.id"), nullable=False
            ),
            sa.Column("request_id", sa.String(64), nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("fingerprint", sa.String(64), nullable=False),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("stage", sa.String(30), nullable=False),
            sa.Column("application_scope", sa.JSON(), nullable=False),
            sa.Column("partial_content", sa.Text(), nullable=False),
            sa.Column("error", sa.Text(), nullable=False),
            sa.Column("error_status", sa.Integer(), nullable=False),
            sa.Column("error_code", sa.String(50), nullable=False),
            sa.Column("diagnostic_id", sa.String(32), nullable=False),
            sa.Column("worker_token", sa.String(64), nullable=False),
            sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("task_id", "request_id", name="uq_assistant_requests_request"),
        )
        op.create_index(
            "ix_assistant_requests_queue", "assistant_requests", ["status", "created_at"]
        )


def downgrade():
    bind = op.get_bind()
    if bind.execute(sa.text("SELECT count(*) FROM assistant_requests")).scalar_one():
        raise RuntimeError(
            "Retain persisted assistant requests; use an image rollback without downgrade"
        )
    op.drop_table("assistant_requests")
    with op.batch_alter_table("assistant_tasks") as batch:
        batch.drop_column("active_request_id")
