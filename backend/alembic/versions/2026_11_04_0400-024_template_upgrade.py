"""Persist explicit template-to-project mapping; retain upgrade history on rollback."""

import sqlalchemy as sa

from alembic import op

revision = "024"
down_revision = "023"
branch_labels = None
depends_on = None


def upgrade():
    if not sa.inspect(op.get_bind()).has_table("project_template_states"):
        op.create_table(
            "project_template_states",
            sa.Column(
                "project_id",
                sa.String(64),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("task_mapping", sa.JSON(), nullable=False),
            sa.Column("sub_mapping", sa.JSON(), nullable=False),
            sa.Column("removed_nodes", sa.JSON(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )


def downgrade():
    pass
