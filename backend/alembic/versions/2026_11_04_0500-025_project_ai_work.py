"""Durable project AI jobs and confirmed action lineage. Preserve records on rollback."""

import sqlalchemy as sa

from alembic import op

revision = "025"
down_revision = "024"
branch_labels = None
depends_on = None


def upgrade():
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "project_ai_jobs" not in tables:
        op.create_table(
            "project_ai_jobs",
            sa.Column("id", sa.String(40), primary_key=True),
            sa.Column(
                "project_id",
                sa.String(64),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True)),
            sa.Column("finished_at", sa.DateTime(timezone=True)),
            sa.Column("state", sa.String(16), nullable=False),
            sa.Column("focus", sa.Text(), nullable=False),
            sa.Column("prompt", sa.Text(), nullable=False),
            sa.Column("context", sa.JSON(), nullable=False),
            sa.Column("source", sa.JSON(), nullable=False),
            sa.Column(
                "analysis_id",
                sa.String(40),
                sa.ForeignKey("project_ai_analyses.id", ondelete="SET NULL"),
            ),
            sa.Column("error", sa.Text(), nullable=False),
            sa.Column("claim", sa.String(40)),
        )
        for name in ("project_id", "created_by", "state"):
            op.create_index("ix_project_ai_jobs_" + name, "project_ai_jobs", [name])
    if "project_ai_actions" not in tables:
        op.create_table(
            "project_ai_actions",
            sa.Column("id", sa.String(40), primary_key=True),
            sa.Column(
                "analysis_id",
                sa.String(40),
                sa.ForeignKey("project_ai_analyses.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("action_key", sa.String(80), nullable=False),
            sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("draft", sa.JSON(), nullable=False),
            sa.Column("result", sa.JSON(), nullable=False),
        )
        op.create_index("ix_project_ai_actions_analysis_id", "project_ai_actions", ["analysis_id"])


def downgrade():
    pass  # Image rollback must retain reports, queued work and accepted action history.
