"""Existing production DDL may precede the ledger; never re-lock or narrow audit IDs."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import sqlalchemy as sa

PATH = Path(__file__).parents[1] / "alembic/versions/2026_11_03_0400-020_pm_execution.py"
TABLES = {
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


def migration(monkeypatch, column_type, dialect="postgresql", missing=False):
    spec = importlib.util.spec_from_file_location("pm_execution_idempotence", PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    inspector = SimpleNamespace(
        get_table_names=lambda: TABLES,
        get_columns=lambda table: [{"name": "revision", "type": sa.Integer()}]
        if table == "tasks"
        else []
        if missing
        else [{"name": "target_id", "type": column_type}],
    )
    bind = SimpleNamespace(dialect=SimpleNamespace(name=dialect))
    monkeypatch.setattr(module.op, "get_bind", lambda: bind)
    monkeypatch.setattr(module.sa, "inspect", lambda connection: inspector)
    alter = Mock()
    monkeypatch.setattr(module.op, "alter_column", alter)
    monkeypatch.setattr(
        module.op,
        "create_table",
        Mock(side_effect=AssertionError("Existing table must not be recreated")),
    )
    return module, alter


@pytest.mark.parametrize("column_type", [sa.String(64), sa.String(80), sa.Text()])
def test_existing_audit_identifier_width_is_preserved_without_exclusive_ddl(
    monkeypatch, column_type
):
    module, alter = migration(monkeypatch, column_type)
    module.upgrade()
    module.upgrade()
    alter.assert_not_called()


def test_old_short_audit_identifier_is_widened_with_its_actual_existing_type(monkeypatch):
    column_type = sa.String(40)
    module, alter = migration(monkeypatch, column_type)
    module.upgrade()
    args, kwargs = alter.call_args
    assert args == ("audit_logs", "target_id")
    assert kwargs["existing_type"] is column_type
    assert kwargs["type_"].length == 64
    alter.assert_called_once()


def test_sqlite_does_not_receive_postgresql_type_alteration(monkeypatch):
    module, alter = migration(monkeypatch, sa.String(40), dialect="sqlite")
    module.upgrade()
    alter.assert_not_called()


def test_missing_audit_identifier_blocks_migration_instead_of_advancing_ledger(monkeypatch):
    module, alter = migration(monkeypatch, sa.String(40), missing=True)
    with pytest.raises(StopIteration):
        module.upgrade()
    alter.assert_not_called()
