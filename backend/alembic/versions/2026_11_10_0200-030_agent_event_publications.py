"""Keep the publication order separate from transaction-local activity timestamps."""

import sqlalchemy as sa

from alembic import op

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("agent_event_publications"):
        op.create_table(
            "agent_event_publications",
            sa.Column("sequence", sa.Integer(), primary_key=True),
            sa.Column(
                "project_id",
                sa.String(64),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "activity_id",
                sa.String(64),
                sa.ForeignKey("task_activities.id", ondelete="CASCADE"),
                nullable=False,
                unique=True,
            ),
            sa.Column("kind", sa.String(20), nullable=False),
            sqlite_autoincrement=True,
        )
    op.create_index(
        "ix_agent_event_publications_project_sequence",
        "agent_event_publications",
        ["project_id", "sequence"],
        if_not_exists=True,
    )


def downgrade():
    op.drop_table("agent_event_publications", if_exists=True)
