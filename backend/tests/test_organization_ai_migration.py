"""The additive shared registry migration preserves legacy model and task storage."""

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_shared_registry_upgrade_is_additive_idempotent_and_scoped(tmp_path):
    source = Path(__file__).parents[1] / "alembic/versions/2026_11_05_0100-027_organization_ai.py"
    spec = importlib.util.spec_from_file_location("shared_registry_migration", source)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.revision == "027" and migration.down_revision == "026"
    engine = create_engine(f'sqlite:///{tmp_path / "migration.db"}')
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE solution_ai_settings (issuer TEXT, owner_id TEXT, revision INTEGER, encrypted_payload TEXT, PRIMARY KEY(issuer, owner_id))"
            )
        )
        connection.execute(
            text(
                "INSERT INTO solution_ai_settings VALUES ('issuer', 'owner', 4, 'synthetic-ciphertext')"
            )
        )
        connection.execute(
            text("CREATE TABLE assistant_tasks (id TEXT PRIMARY KEY, model_profile_id TEXT)")
        )
        connection.execute(
            text("INSERT INTO assistant_tasks VALUES ('old-task', 'old-private-profile')")
        )
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        migration.upgrade()
        metadata = inspect(connection)
        assert metadata.get_pk_constraint("organization_ai_settings")["constrained_columns"] == [
            "issuer",
            "organization",
        ]
        assert {column["name"] for column in metadata.get_columns("organization_ai_settings")} == {
            "issuer",
            "organization",
            "revision",
            "encrypted_payload",
        }
        assert connection.execute(
            text("SELECT revision, encrypted_payload FROM solution_ai_settings")
        ).one() == (4, "synthetic-ciphertext")
        assert (
            connection.execute(text("SELECT model_profile_id FROM assistant_tasks")).scalar_one()
            == "old-private-profile"
        )
        migration.downgrade()
        assert not inspect(connection).has_table("organization_ai_settings")
        assert inspect(connection).has_table("solution_ai_settings") and inspect(
            connection
        ).has_table("assistant_tasks")
    engine.dispose()
