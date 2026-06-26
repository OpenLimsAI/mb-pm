"""initial schema — 11 张表

Revision ID: 001
Revises:
Create Date: 2026-05-08 00:00:00

手写而非 autogenerate — 这样不需要现有 DB 也能反向构建出整个 schema。
后续 schema 修改：使用 `alembic revision --autogenerate -m "<desc>"`。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ============= users =============
    op.create_table(
        "users",
        sa.Column("id", sa.String(20), primary_key=True),
        sa.Column("username", sa.String(50), nullable=False, unique=True),
        sa.Column("display_name", sa.String(50), nullable=False),
        sa.Column("email", sa.String(120), nullable=False, unique=True),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("specialty_group", sa.String(20)),
        sa.Column("weekly_available_hours", sa.Integer, nullable=False, server_default="40"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("avatar_color", sa.String(20)),
        sa.Column("hashed_password", sa.String(120)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_users_username", "users", ["username"])
    op.create_index("ix_users_role", "users", ["role"])

    # ============= templates =============
    op.create_table(
        "templates",
        sa.Column("id", sa.String(20), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("product_type", sa.String(20), nullable=False),
        sa.Column("current_version", sa.String(20), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(20), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_templates_product_type", "templates", ["product_type"])

    op.create_table(
        "template_versions",
        sa.Column("id", sa.String(30), primary_key=True),
        sa.Column("template_id", sa.String(20), sa.ForeignKey("templates.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_number", sa.String(20), nullable=False),
        sa.Column("structure_json", postgresql.JSONB, nullable=False),
        sa.Column("change_summary", sa.Text),
        sa.Column("change_source", sa.String(20), nullable=False),
        sa.Column("modified_by", sa.String(20), sa.ForeignKey("users.id")),
        sa.Column("modified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_current", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_template_versions_template_id", "template_versions", ["template_id"])
    op.create_index("ix_template_versions_is_current", "template_versions", ["is_current"])

    # ============= projects =============
    op.create_table(
        "projects",
        sa.Column("id", sa.String(20), primary_key=True),
        sa.Column("code", sa.String(40), nullable=False, unique=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("product_type", sa.String(20), nullable=False),
        sa.Column("current_stage", sa.String(20), nullable=False),
        sa.Column("target_stage", sa.String(20), nullable=False),
        sa.Column("owner_id", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("health", sa.String(10), nullable=False),
        sa.Column("progress", sa.Integer, nullable=False, server_default="0"),
        sa.Column("planned_start", sa.Date, nullable=False),
        sa.Column("planned_end", sa.Date, nullable=False),
        sa.Column("template_id", sa.String(20), sa.ForeignKey("templates.id")),
        sa.Column("template_version", sa.String(20)),
        sa.Column("description", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_projects_code", "projects", ["code"])
    op.create_index("ix_projects_owner_id", "projects", ["owner_id"])
    op.create_index("ix_projects_status", "projects", ["status"])
    op.create_index("ix_projects_health", "projects", ["health"])

    op.create_table(
        "project_members",
        sa.Column("project_id", sa.String(20), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(20), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.PrimaryKeyConstraint("project_id", "user_id", name="pk_project_members"),
    )

    # ============= sub_projects =============
    op.create_table(
        "sub_projects",
        sa.Column("id", sa.String(20), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("project_id", sa.String(20), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stage", sa.String(20), nullable=False),
        sa.Column("module", sa.String(20), nullable=False),
        sa.Column("owner_id", sa.String(20), sa.ForeignKey("users.id")),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("progress", sa.Integer, server_default="0"),
        sa.Column("sort_order", sa.Integer, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_sub_projects_project_id", "sub_projects", ["project_id"])
    op.create_index("ix_sub_projects_module", "sub_projects", ["module"])

    # ============= tasks =============
    op.create_table(
        "tasks",
        sa.Column("id", sa.String(20), primary_key=True),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sub_project_id", sa.String(20), sa.ForeignKey("sub_projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_id", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("collaborator_ids", postgresql.ARRAY(sa.String(20))),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("priority", sa.String(10), nullable=False),
        sa.Column("planned_start", sa.Date, nullable=False),
        sa.Column("planned_end", sa.Date, nullable=False),
        sa.Column("actual_start", sa.Date),
        sa.Column("actual_end", sa.Date),
        sa.Column("estimated_effort", sa.Numeric(6, 2), server_default="0"),
        sa.Column("actual_effort", sa.Numeric(6, 2)),
        sa.Column("progress", sa.Integer, server_default="0"),
        sa.Column("is_milestone", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("is_critical_path", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("notes", sa.Text),
        sa.Column("tags", postgresql.ARRAY(sa.String(50))),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_tasks_code", "tasks", ["code"])
    op.create_index("ix_tasks_sub_project_id", "tasks", ["sub_project_id"])
    op.create_index("ix_tasks_owner_id", "tasks", ["owner_id"])
    op.create_index("ix_tasks_status", "tasks", ["status"])
    op.create_index("ix_tasks_is_milestone", "tasks", ["is_milestone"])

    op.create_table(
        "task_dependencies",
        sa.Column("id", sa.String(30), primary_key=True),
        sa.Column("predecessor_id", sa.String(20), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("successor_id", sa.String(20), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.String(2), nullable=False),
        sa.Column("lag_days", sa.Integer, server_default="0"),
    )

    # ============= resources =============
    op.create_table(
        "resources",
        sa.Column("id", sa.String(20), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("location", sa.String(120)),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_resources_type", "resources", ["type"])

    op.create_table(
        "resource_bookings",
        sa.Column("id", sa.String(30), primary_key=True),
        sa.Column("resource_id", sa.String(20), sa.ForeignKey("resources.id"), nullable=False),
        sa.Column("project_id", sa.String(20), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("task_id", sa.String(20), sa.ForeignKey("tasks.id")),
        sa.Column("start_date", sa.Date, nullable=False),
        sa.Column("end_date", sa.Date, nullable=False),
        sa.Column("booked_by", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_resource_bookings_resource_id", "resource_bookings", ["resource_id"])
    op.create_index("ix_resource_bookings_project_id", "resource_bookings", ["project_id"])

    # ============= batches + production =============
    op.create_table(
        "batches",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("batch_code", sa.String(60), nullable=False, unique=True),
        sa.Column("project_id", sa.String(20), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("product_name", sa.String(200), nullable=False),
        sa.Column("batch_type", sa.String(40), nullable=False),
        sa.Column("current_stage", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("planned_start", sa.Date, nullable=False),
        sa.Column("planned_end", sa.Date, nullable=False),
        sa.Column("actual_start", sa.Date),
        sa.Column("actual_release", sa.Date),
        sa.Column("stage_progress", postgresql.JSONB, nullable=False),
        sa.Column("planned_yield", sa.Numeric(10, 2), nullable=False),
        sa.Column("actual_yield", sa.Numeric(10, 2)),
        sa.Column("yield_rate", sa.Numeric(5, 2)),
        sa.Column("owner_id", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("resource_ids", postgresql.ARRAY(sa.String(20))),
        sa.Column("task_id", sa.String(20), sa.ForeignKey("tasks.id")),
        sa.Column("deviation_count", sa.Integer, server_default="0"),
        sa.Column("notes", sa.Text),
        sa.Column("cpps", postgresql.JSONB),
        sa.Column("cqas", postgresql.JSONB),
        sa.Column("raw_materials", postgresql.JSONB),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_batches_batch_code", "batches", ["batch_code"])
    op.create_index("ix_batches_project_id", "batches", ["project_id"])
    op.create_index("ix_batches_status", "batches", ["status"])
    op.create_index("ix_batches_current_stage", "batches", ["current_stage"])
    op.create_index("ix_batches_batch_type", "batches", ["batch_type"])
    op.create_index("ix_batches_owner_id", "batches", ["owner_id"])

    op.create_table(
        "equipment_status",
        sa.Column("resource_id", sa.String(20), sa.ForeignKey("resources.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("current_batch_id", sa.String(40), sa.ForeignKey("batches.id")),
        sa.Column("operator_id", sa.String(20), sa.ForeignKey("users.id")),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("run_until_estimate", sa.DateTime(timezone=True)),
        sa.Column("utilization_rate_7d", sa.Integer, server_default="0"),
        sa.Column("maintenance_due", sa.Date),
        sa.Column("notes", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_equipment_status_status", "equipment_status", ["status"])

    op.create_table(
        "batch_deviations",
        sa.Column("id", sa.String(30), primary_key=True),
        sa.Column("deviation_code", sa.String(40), nullable=False, unique=True),
        sa.Column("batch_id", sa.String(40), sa.ForeignKey("batches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.String(40), nullable=False),
        sa.Column("severity", sa.String(10), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("owner_id", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reporter_id", sa.String(20), sa.ForeignKey("users.id")),
        sa.Column("reported_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("due_date", sa.Date),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.Column("root_cause", sa.Text),
        sa.Column("impact_assessment", sa.Text),
        sa.Column("affected_batch_ids", postgresql.ARRAY(sa.String(40))),
        sa.Column("investigations", postgresql.JSONB),
        sa.Column("capa_actions", postgresql.JSONB),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_batch_deviations_batch_id", "batch_deviations", ["batch_id"])
    op.create_index("ix_batch_deviations_severity", "batch_deviations", ["severity"])
    op.create_index("ix_batch_deviations_status", "batch_deviations", ["status"])

    # ============= alerts + audit_logs =============
    op.create_table(
        "alerts",
        sa.Column("id", sa.String(30), primary_key=True),
        sa.Column("type", sa.String(40), nullable=False),
        sa.Column("severity", sa.String(10), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("project_id", sa.String(20), sa.ForeignKey("projects.id")),
        sa.Column("task_id", sa.String(20), sa.ForeignKey("tasks.id")),
        sa.Column("is_read", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("triggered_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_alerts_is_read", "alerts", ["is_read"])
    op.create_index("ix_alerts_severity", "alerts", ["severity"])

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.String(30), primary_key=True),
        sa.Column("actor_id", sa.String(20), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("action", sa.String(40), nullable=False),
        sa.Column("target", sa.String(40), nullable=False),
        sa.Column("target_id", sa.String(40), nullable=False),
        sa.Column("detail", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, index=True),
    )
    op.create_index("ix_audit_logs_actor_id", "audit_logs", ["actor_id"])
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])


def downgrade() -> None:
    """完整回滚。"""
    op.drop_table("audit_logs")
    op.drop_table("alerts")
    op.drop_table("batch_deviations")
    op.drop_table("equipment_status")
    op.drop_table("batches")
    op.drop_table("resource_bookings")
    op.drop_table("resources")
    op.drop_table("task_dependencies")
    op.drop_table("tasks")
    op.drop_table("sub_projects")
    op.drop_table("project_members")
    op.drop_table("projects")
    op.drop_table("template_versions")
    op.drop_table("templates")
    op.drop_table("users")
