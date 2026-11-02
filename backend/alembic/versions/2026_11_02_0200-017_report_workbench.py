"""Report organization, personal outline templates, and owned topic metadata."""

import sqlalchemy as sa

from alembic import op

revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("knowledge_solutions")}
    if "pinned" not in columns:
        op.add_column(
            "knowledge_solutions",
            sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if "tags" not in columns:
        op.add_column(
            "knowledge_solutions", sa.Column("tags", sa.JSON(), nullable=False, server_default="[]")
        )
    tables = set(sa.inspect(bind).get_table_names())
    if "solution_templates" not in tables:
        op.create_table(
            "solution_templates",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("issuer", sa.String(255), nullable=False),
            sa.Column("owner_id", sa.String(255), nullable=False),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("sections", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_solution_templates_issuer", "solution_templates", ["issuer"])
        op.create_index("ix_solution_templates_owner_id", "solution_templates", ["owner_id"])
    if "solution_topics" not in tables:
        op.create_table(
            "solution_topics",
            sa.Column(
                "solution_id",
                sa.String(64),
                sa.ForeignKey("knowledge_solutions.id"),
                primary_key=True,
            ),
            sa.Column("id", sa.String(80), primary_key=True),
            sa.Column("title", sa.String(200), nullable=False),
            sa.Column("archived", sa.Boolean(), nullable=False),
            sa.Column("deleted", sa.Boolean(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
        )


def downgrade():
    op.drop_table("solution_topics")
    op.drop_table("solution_templates")
    op.drop_column("knowledge_solutions", "tags")
    op.drop_column("knowledge_solutions", "pinned")
