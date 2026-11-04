"""Frozen migrations retain queued work and confirmed actions across image rollback."""

import importlib.util
from pathlib import Path

import sqlalchemy as sa

from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models.project_ai_work import ProjectAIAction, ProjectAIJob
from app.models.template_upgrade import ProjectTemplateState


def test_project_tools_migrations_match_models_and_preserve_records(monkeypatch):
    engine = sa.create_engine("sqlite://")
    folder = Path(__file__).parents[1] / "alembic/versions"
    with engine.begin() as connection:
        for ddl in (
            "CREATE TABLE projects (id VARCHAR(64) PRIMARY KEY)",
            "CREATE TABLE users (id VARCHAR(20) PRIMARY KEY)",
            "CREATE TABLE project_ai_analyses (id VARCHAR(40) PRIMARY KEY)",
        ):
            connection.execute(sa.text(ddl))
        migrations = []
        for number in ("024", "025"):
            filename = next(folder.glob(f"*-{number}_*.py"))
            spec = importlib.util.spec_from_file_location(f"tools_migration_{number}", filename)
            migration = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(migration)
            monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
            migration.upgrade()
            migration.upgrade()
            migrations.append(migration)
        for model in (ProjectTemplateState, ProjectAIJob, ProjectAIAction):
            columns = {
                col["name"]: col for col in sa.inspect(connection).get_columns(model.__tablename__)
            }
            assert set(columns) == set(model.__table__.columns.keys())
            for column in model.__table__.columns:
                assert columns[column.name]["nullable"] == column.nullable
                assert getattr(columns[column.name]["type"], "length", None) == getattr(
                    column.type, "length", None
                )
        connection.execute(
            sa.text(
                "INSERT INTO project_ai_jobs (id,project_id,created_by,created_at,state,focus,prompt,context,source,error) VALUES ('job','p','u',CURRENT_TIMESTAMP,'queued','','','{}','{}','')"
            )
        )
        connection.execute(
            sa.text(
                "INSERT INTO project_ai_actions VALUES ('a','r','key','u',CURRENT_TIMESTAMP,'{}','{}')"
            )
        )
        for migration in reversed(migrations):
            migration.downgrade()
        for migration in migrations:
            migration.upgrade()
        assert (
            connection.execute(sa.text("SELECT state FROM project_ai_jobs WHERE id='job'")).scalar()
            == "queued"
        )
        assert connection.execute(sa.text("SELECT count(*) FROM project_ai_actions")).scalar() == 1
