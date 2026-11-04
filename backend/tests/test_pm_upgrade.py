"""Additive PM schema upgrade preserves customer values, including unfilled old WBS order."""

import importlib
from datetime import date

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app.db import upgrade
from app.db.base import Base
from app.models import Project, SubProject, Task, User

NEW_TABLES = {
    "pm_saved_views",
    "project_calendars",
    "user_weekly_capacities",
    "task_activities",
    "task_deliverables",
    "task_acceptances",
    "pm_register_entries",
    "pm_cost_entries",
    "pm_notification_states",
    "pm_notification_preferences",
}


@pytest.fixture
def legacy_engine(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(
        engine,
        tables=[table for table in Base.metadata.sorted_tables if table.name not in NEW_TABLES],
    )
    with Session(engine) as db:
        for uid in ("upgrade-owner", "upgrade-executor"):
            db.add(
                User(
                    id=uid,
                    username=uid,
                    display_name=uid,
                    email=f"{uid}@example.com",
                    role="rd",
                    weekly_available_hours=40,
                    is_active=True,
                )
            )
        db.flush()
        db.add(
            Project(
                id="upgrade-project",
                code="UPGRADE",
                name="历史项目",
                product_type="其他",
                current_stage="IND",
                target_stage="IND",
                owner_id="upgrade-owner",
                status="活跃",
                health="green",
                progress=20,
                planned_start=date(2026, 11, 1),
                planned_end=date(2026, 11, 30),
            )
        )
        db.flush()
        db.add(
            SubProject(
                id="upgrade-sub",
                project_id="upgrade-project",
                name="历史子项目",
                stage="IND",
                module="USP",
                status="进行中",
                progress=20,
                sort_order=0,
            )
        )
        db.flush()
        db.add(
            Task(
                id="upgrade-task",
                code="T1",
                name="历史任务",
                sub_project_id="upgrade-sub",
                owner_id="upgrade-executor",
                planned_start=date(2026, 11, 1),
                planned_end=date(2026, 11, 10),
                status="进行中",
                progress=20,
                priority="中",
                estimated_effort=5,
                actual_effort=1,
                sort_order=None,
            )
        )
        db.commit()
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE tasks DROP COLUMN revision"))
    main_module = importlib.import_module("app.main")
    monkeypatch.setattr(upgrade, "engine", engine)
    monkeypatch.setattr(main_module, "engine", engine)
    monkeypatch.setattr(main_module, "SessionLocal", sessionmaker(bind=engine))
    yield engine
    engine.dispose()


def old_values(engine):
    with engine.connect() as conn:
        values = {}
        for table in (
            "projects",
            "sub_projects",
            "tasks",
            "task_dependencies",
            "project_members",
            "project_finances",
            "project_baselines",
        ):
            columns = [
                column["name"]
                for column in inspect(conn).get_columns(table)
                if column["name"] != "revision"
            ]
            selected = ",".join(f'"{column}"' for column in columns)
            values[table] = [
                tuple(row) for row in conn.execute(text(f'SELECT {selected} FROM "{table}"'))
            ]
        return values


def test_schema_only_is_idempotent_and_preserves_old_business_values(legacy_engine):
    before = old_values(legacy_engine)
    upgrade.main(schema_only=True)
    upgrade.main(schema_only=True)
    assert old_values(legacy_engine) == before
    assert NEW_TABLES <= set(inspect(legacy_engine).get_table_names())
    with legacy_engine.connect() as conn:
        assert conn.execute(text("SELECT revision FROM tasks")).scalar_one() == 1
        assert conn.execute(text("SELECT sort_order FROM tasks")).scalar_one() is None
        assert conn.execute(text("SELECT count(*) FROM project_members")).scalar_one() == 0


def test_default_upgrade_retains_historical_backfills(legacy_engine):
    upgrade.main()
    with legacy_engine.connect() as conn:
        assert conn.execute(text("SELECT sort_order FROM tasks")).scalar_one() is not None
        assert (
            conn.execute(
                text("SELECT count(*) FROM project_members WHERE user_id='upgrade-executor'")
            ).scalar_one()
            == 1
        )


def migration_020(connection):
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = (
        Path(__file__).resolve().parents[1] / "alembic/versions/2026_11_03_0400-020_pm_execution.py"
    )
    spec = importlib.util.spec_from_file_location("pm_execution_020", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    migration.op = Operations(
        MigrationContext.configure(connection, opts={"target_metadata": Base.metadata})
    )
    return migration


def test_alembic_020_matches_orm_and_repeated_upgrade_retains_records(legacy_engine):
    before = old_values(legacy_engine)
    with legacy_engine.begin() as conn:
        migration = migration_020(conn)
        migration.upgrade()
        migration.upgrade()
    assert old_values(legacy_engine) == before
    inspector = inspect(legacy_engine)
    for name in NEW_TABLES:
        actual = {column["name"]: column for column in inspector.get_columns(name)}
        expected = Base.metadata.tables[name]
        assert set(actual) == set(expected.columns.keys()), name
        for column in expected.columns:
            current = actual[column.name]
            assert current["nullable"] == column.nullable, (name, column.name)
            assert bool(current["primary_key"]) == bool(column.primary_key), (name, column.name)
            assert current["type"]._type_affinity is column.type._type_affinity, (name, column.name)
            assert getattr(current["type"], "length", None) == getattr(
                column.type, "length", None
            ), (name, column.name)
        assert {index["name"] for index in inspector.get_indexes(name)} == {
            index.name for index in expected.indexes
        }, name
        actual_foreign = {
            (
                tuple(fk["constrained_columns"]),
                fk["referred_table"],
                tuple(fk["referred_columns"]),
                fk["options"].get("ondelete"),
            )
            for fk in inspector.get_foreign_keys(name)
        }
        expected_foreign = {
            (
                tuple(fk.column_keys),
                next(iter(fk.elements)).column.table.name,
                tuple(element.column.name for element in fk.elements),
                fk.ondelete,
            )
            for fk in expected.foreign_key_constraints
        }
        assert actual_foreign == expected_foreign, name
        actual_unique = {
            (unique["name"], tuple(unique["column_names"]))
            for unique in inspector.get_unique_constraints(name)
        }
        from sqlalchemy import UniqueConstraint

        expected_unique = {
            (unique.name, tuple(unique.columns.keys()))
            for unique in expected.constraints
            if isinstance(unique, UniqueConstraint)
        }
        assert actual_unique == expected_unique, name
    # ORM insert also checks server timestamp defaults in the actually migrated schema.
    from app.models.pm_view import PMView

    with Session(legacy_engine) as db:
        db.add(
            PMView(
                id="migration-view",
                user_id="upgrade-owner",
                kind="tasks",
                name="旧库升级后视图",
                state={},
            )
        )
        db.commit()
    with legacy_engine.begin() as conn:
        migration = migration_020(conn)
        migration.downgrade()
        migration.upgrade()
        assert (
            conn.execute(
                text("SELECT name FROM pm_saved_views WHERE id='migration-view'")
            ).scalar_one()
            == "旧库升级后视图"
        )
    assert old_values(legacy_engine) == before
