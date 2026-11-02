"""Task continuity, explicit artifacts, source provenance and operator settings."""

import sqlalchemy as sa

from alembic import op

revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    additions = {
        "assistant_tasks": [
            sa.Column("memory", sa.Text(), nullable=False, server_default=""),
            sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("final_artifact_id", sa.String(64), nullable=True),
        ],
        "assistant_messages": [
            sa.Column("knowledge_references", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("source_summary", sa.JSON(), nullable=False, server_default="{}"),
        ],
        "assistant_requests": [
            sa.Column("first_content_at", sa.DateTime(timezone=True), nullable=True),
        ],
    }
    for table, columns in additions.items():
        existing = {c["name"] for c in sa.inspect(bind).get_columns(table)}
        for column in columns:
            if column.name not in existing:
                op.add_column(table, column)
    if "assistant_operations_config" not in sa.inspect(bind).get_table_names():
        op.create_table(
            "assistant_operations_config",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("limits", sa.JSON(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade():
    raise RuntimeError(
        "Retain assistant history and settings; roll back the image, not this schema"
    )
