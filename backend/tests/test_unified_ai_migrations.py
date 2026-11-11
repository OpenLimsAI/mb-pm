"""The combined PM/Agent migration chain preserves both sets of execution evidence."""

import ast
import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import sqlalchemy as sa

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from app.core.config import settings

BACKEND = Path(__file__).parents[1]
VERSIONS = BACKEND / "alembic/versions"


def migration_config():
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    return config


def migration(number):
    filename = next(VERSIONS.glob(f"*-{number}_*.py"))
    spec = importlib.util.spec_from_file_location(f"unified_ai_migration_{number}", filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def apply(connection, number):
    module = migration(number)
    module.op = Operations(MigrationContext.configure(connection))
    module.upgrade()


def seed_run(connection):
    table = sa.Table("pm_ai_runs", sa.MetaData(), autoload_with=connection)
    connection.execute(
        table.insert().values(
            id="preserved-run",
            created_by="u",
            created_at=datetime.now(UTC),
            state="completed",
            request={"project_ids": ["p"]},
            context={"evidence": "preserve"},
            source={"complete": True},
            result={"summary": "preserved"},
            usage={},
            error="",
        )
    )


def seed_agent_evidence(connection):
    proposal = sa.Table("agent_proposals", sa.MetaData(), autoload_with=connection)
    events = sa.Table("agent_event_publications", sa.MetaData(), autoload_with=connection)
    connection.execute(
        proposal.insert().values(
            id="preserved-proposal",
            project_id="p",
            created_by="u",
            kind="schedule",
            state="executed",
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            draft={"task_id": "t"},
            request_digest="a" * 64,
            snapshot_digest="b" * 64,
            changes=[],
            result={"receipt": "preserve"},
        )
    )
    connection.execute(events.insert().values(project_id="p", activity_id="a", kind="delay"))


def test_unified_migration_graph_has_unique_revisions_and_keeps_historical_branch():
    revisions = []
    for filename in VERSIONS.glob("*.py"):
        for node in ast.parse(filename.read_text()).body:
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "revision" for target in node.targets
            ):
                revisions.append(ast.literal_eval(node.value))
    assert len(revisions) == len(set(revisions))
    scripts = ScriptDirectory.from_config(migration_config())
    assert set(scripts.get_heads()) == {"007", "030"}
    assert scripts.get_revision("028").down_revision == "027"
    assert scripts.get_revision("029").down_revision == "028"
    assert scripts.get_revision("030").down_revision == "029"


@pytest.mark.parametrize(
    ("starting_revision", "existing_agent_tables"),
    [("027", False), ("028", False), ("028", True)],
    ids=["existing-business-027", "existing-pm-028", "auto-created-agent-tables"],
)
def test_existing_database_upgrades_without_losing_ai_evidence(
    tmp_path, monkeypatch, starting_revision, existing_agent_tables
):
    url = f"sqlite:///{tmp_path / 'upgrade.db'}"
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    engine = sa.create_engine(url)
    with engine.begin() as connection:
        for ddl in (
            "CREATE TABLE users (id VARCHAR(20) PRIMARY KEY)",
            "CREATE TABLE projects (id VARCHAR(64) PRIMARY KEY)",
            "CREATE TABLE task_activities (id VARCHAR(64) PRIMARY KEY)",
            "INSERT INTO users VALUES ('u')",
            "INSERT INTO projects VALUES ('p')",
            "INSERT INTO task_activities VALUES ('a')",
        ):
            connection.execute(sa.text(ddl))
        if starting_revision == "028":
            apply(connection, "028")
            seed_run(connection)
        if existing_agent_tables:
            apply(connection, "029")
            apply(connection, "030")
            seed_agent_evidence(connection)
    config = migration_config()
    command.stamp(config, starting_revision)
    command.upgrade(config, "030")
    command.upgrade(config, "030")
    with engine.begin() as connection:
        assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == "030"
        tables = set(sa.inspect(connection).get_table_names())
        assert {
            "pm_ai_runs",
            "pm_ai_change_receipts",
            "agent_proposals",
            "agent_event_publications",
        } <= tables
        assert connection.scalar(sa.text("SELECT id FROM projects")) == "p"
        assert connection.scalar(sa.text("SELECT id FROM users")) == "u"
        if starting_revision == "028":
            row = connection.execute(sa.text("SELECT state,context FROM pm_ai_runs")).one()
            assert row.state == "completed" and "preserve" in row.context
        if existing_agent_tables:
            assert connection.scalar(sa.text("SELECT state FROM agent_proposals")) == "executed"
            assert (
                connection.scalar(sa.text("SELECT kind FROM agent_event_publications")) == "delay"
            )
        # Existing-table application is safe as well as an already-current ledger.
        for number in ("028", "029", "030"):
            apply(connection, number)
    engine.dispose()
