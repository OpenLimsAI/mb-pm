"""Project execution and collaboration; additive migration, retain history on rollback."""

import sqlalchemy as sa

from alembic import op

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "revision" not in {c["name"] for c in inspector.get_columns("tasks")}:
        op.add_column(
            "tasks", sa.Column("revision", sa.Integer(), nullable=False, server_default="1")
        )
    if bind.dialect.name == "postgresql":
        op.alter_column("audit_logs", "target_id", type_=sa.String(64), existing_type=sa.String(40))
    if "pm_saved_views" not in tables:
        op.create_table(
            "pm_saved_views",
            sa.Column("id", sa.String(length=64), nullable=False, primary_key=True),
            sa.Column("user_id", sa.String(length=20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("kind", sa.String(length=16), nullable=False),
            sa.Column("name", sa.String(length=80), nullable=False),
            sa.Column("state", sa.JSON(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint("user_id", "kind", "name"),
        )
        op.create_index("ix_pm_saved_views_user_id", "pm_saved_views", ["user_id"], unique=False)
    if "project_calendars" not in tables:
        op.create_table(
            "project_calendars",
            sa.Column(
                "project_id",
                sa.String(length=64),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                nullable=False,
                primary_key=True,
            ),
            sa.Column("weekdays", sa.JSON(), nullable=False),
            sa.Column("holidays", sa.JSON(), nullable=False),
            sa.Column("working_dates", sa.JSON(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
    if "user_weekly_capacities" not in tables:
        op.create_table(
            "user_weekly_capacities",
            sa.Column("id", sa.String(length=80), nullable=False, primary_key=True),
            sa.Column(
                "user_id",
                sa.String(length=20),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("week_start", sa.String(length=10), nullable=False),
            sa.Column("available_hours", sa.Float(), nullable=False),
            sa.Column("leave_hours", sa.Float(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            "ix_user_weekly_capacities_user_id", "user_weekly_capacities", ["user_id"], unique=False
        )
    if "task_activities" not in tables:
        op.create_table(
            "task_activities",
            sa.Column("id", sa.String(length=64), nullable=False, primary_key=True),
            sa.Column(
                "task_id",
                sa.String(length=64),
                sa.ForeignKey("tasks.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("actor_id", sa.String(length=20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("kind", sa.String(length=30), nullable=False),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("changes", sa.JSON(), nullable=False),
            sa.Column("mention_ids", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_task_activities_task_id", "task_activities", ["task_id"], unique=False)
        op.create_index(
            "ix_task_activities_actor_id", "task_activities", ["actor_id"], unique=False
        )
        op.create_index(
            "ix_task_activities_created_at", "task_activities", ["created_at"], unique=False
        )
    if "task_deliverables" not in tables:
        op.create_table(
            "task_deliverables",
            sa.Column("id", sa.String(length=64), nullable=False, primary_key=True),
            sa.Column(
                "task_id",
                sa.String(length=64),
                sa.ForeignKey("tasks.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("author_id", sa.String(length=20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("filename", sa.String(length=240), nullable=True),
            sa.Column("media_type", sa.String(length=120), nullable=True),
            sa.Column("content", sa.LargeBinary(), nullable=True),
            sa.Column("link", sa.Text(), nullable=True),
            sa.Column("notes", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("task_id", "title", "version", name="uq_task_deliverable_version"),
        )
        op.create_index(
            "ix_task_deliverables_task_id", "task_deliverables", ["task_id"], unique=False
        )
    if "task_acceptances" not in tables:
        op.create_table(
            "task_acceptances",
            sa.Column(
                "task_id",
                sa.String(length=64),
                sa.ForeignKey("tasks.id", ondelete="CASCADE"),
                nullable=False,
                primary_key=True,
            ),
            sa.Column(
                "reviewer_id", sa.String(length=20), sa.ForeignKey("users.id"), nullable=False
            ),
            sa.Column("submitted_deliverable_ids", sa.JSON(), nullable=False),
            sa.Column("required_count", sa.Integer(), nullable=False),
            sa.Column("state", sa.String(length=20), nullable=False),
            sa.Column("comment", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_task_acceptances_state", "task_acceptances", ["state"], unique=False)
        op.create_index(
            "ix_task_acceptances_reviewer_id", "task_acceptances", ["reviewer_id"], unique=False
        )
    if "pm_register_entries" not in tables:
        op.create_table(
            "pm_register_entries",
            sa.Column("id", sa.String(length=40), nullable=False, primary_key=True),
            sa.Column(
                "project_id",
                sa.String(length=64),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("kind", sa.String(length=20), nullable=False),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("owner_id", sa.String(length=20), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("due_date", sa.Date(), nullable=False),
            sa.Column("severity", sa.String(length=10), nullable=False),
            sa.Column("status", sa.String(length=10), nullable=False),
            sa.Column("mitigation", sa.Text(), nullable=False),
            sa.Column("closure", sa.Text(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            "ix_pm_register_entries_project_id", "pm_register_entries", ["project_id"], unique=False
        )
    if "pm_cost_entries" not in tables:
        op.create_table(
            "pm_cost_entries",
            sa.Column("id", sa.String(length=40), nullable=False, primary_key=True),
            sa.Column(
                "project_id",
                sa.String(length=64),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "task_id",
                sa.String(length=64),
                sa.ForeignKey("tasks.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("kind", sa.String(length=20), nullable=False),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("category", sa.String(length=40), nullable=False),
            sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
            sa.Column("occurred_on", sa.Date(), nullable=False),
            sa.Column("evidence_url", sa.String(length=2000), nullable=False),
            sa.Column("notes", sa.Text(), nullable=False),
            sa.Column("voided", sa.Boolean(), nullable=False),
            sa.Column("void_reason", sa.Text(), nullable=False),
            sa.Column("revision", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            "ix_pm_cost_entries_project_id", "pm_cost_entries", ["project_id"], unique=False
        )
    if "pm_notification_states" not in tables:
        op.create_table(
            "pm_notification_states",
            sa.Column(
                "user_id",
                sa.String(length=20),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
                primary_key=True,
            ),
            sa.Column("event_key", sa.String(length=200), nullable=False, primary_key=True),
            sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("snooze_until", sa.DateTime(timezone=True), nullable=True),
        )
    if "pm_notification_preferences" not in tables:
        op.create_table(
            "pm_notification_preferences",
            sa.Column(
                "user_id",
                sa.String(length=20),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
                primary_key=True,
            ),
            sa.Column("mode", sa.String(length=10), nullable=False),
            sa.Column("digest_on", sa.Date(), nullable=True),
            sa.Column("digest_keys", sa.JSON(), nullable=False),
        )


def downgrade():
    # Keep collaboration records, audit references and task versions on an image rollback.
    pass
