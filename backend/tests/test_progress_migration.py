"""Adding policies never rewrites historical progress or execution values."""

import importlib.util
from pathlib import Path

import sqlalchemy as sa

from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_policy_migration_is_additive_idempotent_and_preserves_settings(monkeypatch):
    filename = Path(__file__).parents[1] / "alembic/versions/2026_11_04_0300-023_progress_policy.py"
    spec = importlib.util.spec_from_file_location("progress_migration", filename)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(sa.text("CREATE TABLE projects (id TEXT PRIMARY KEY, progress INTEGER)"))
        connection.execute(
            sa.text(
                "CREATE TABLE tasks (id TEXT PRIMARY KEY, progress INTEGER, actual_cost NUMERIC)"
            )
        )
        connection.execute(sa.text("INSERT INTO projects VALUES ('p', 43)"))
        connection.execute(sa.text("INSERT INTO tasks VALUES ('t', 65, 12.7)"))
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        migration.upgrade()
        assert connection.execute(
            sa.text("SELECT progress, progress_method FROM projects")
        ).one() == (43, "equal")
        assert connection.execute(
            sa.text("SELECT progress, actual_cost, progress_weight FROM tasks")
        ).one() == (65, 12.7, None)
        connection.execute(sa.text("UPDATE projects SET progress_method='custom'"))
        connection.execute(sa.text("UPDATE tasks SET progress_weight=0"))
        migration.downgrade()
        migration.upgrade()
        assert (
            connection.execute(sa.text("SELECT progress_method FROM projects")).scalar() == "custom"
        )
        assert connection.execute(sa.text("SELECT progress_weight FROM tasks")).scalar() == 0
