"""Group report answers into private topics. Revision 008; replaces 007."""

import sqlalchemy as sa

from alembic import op

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "conversation_id" not in {
        column["name"] for column in inspector.get_columns("solution_answers")
    }:
        op.add_column(
            "solution_answers", sa.Column("conversation_id", sa.String(80), nullable=True)
        )
    if "ix_solution_answers_solution_conversation" not in {
        index["name"] for index in inspector.get_indexes("solution_answers")
    }:
        op.create_index(
            "ix_solution_answers_solution_conversation",
            "solution_answers",
            ["solution_id", "conversation_id"],
        )


def downgrade():
    op.drop_index("ix_solution_answers_solution_conversation", table_name="solution_answers")
    with op.batch_alter_table("solution_answers") as batch:
        batch.drop_column("conversation_id")
