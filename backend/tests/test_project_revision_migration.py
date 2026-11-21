"""Adding revisions twice retains legacy project data and revisions on downgrade."""

import importlib.util
from pathlib import Path

import sqlalchemy as sa

from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_project_revision_additive_idempotent_migration():
    path = Path(__file__).parents[1] / "alembic/versions/2026_11_18_0000-032_project_revision.py"
    spec = importlib.util.spec_from_file_location("project_revision_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(
            sa.text("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, progress INTEGER)")
        )
        conn.execute(sa.text("INSERT INTO projects VALUES ('legacy', '原有项目', 27)"))
        context = MigrationContext.configure(conn)
        with Operations.context(context):
            module.upgrade()
            module.upgrade()
            assert conn.execute(sa.text("SELECT name, progress, revision FROM projects")).one() == (
                "原有项目",
                27,
                1,
            )
            conn.execute(sa.text("UPDATE projects SET revision = 9"))
            module.downgrade()
            assert conn.execute(sa.text("SELECT revision FROM projects")).scalar() == 9
    engine.dispose()
