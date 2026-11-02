"""Real PostgreSQL privilege proof; SQLite cannot validate server roles."""

import sys

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from app.core.config import settings
from app.db import runtime_role


def test_runtime_role_cannot_create_tables_or_administer_roles(client, monkeypatch, tmp_path):
    if make_url(settings.DATABASE_URL).get_backend_name() != "postgresql":
        pytest.skip("Requires PostgreSQL role enforcement")
    output = tmp_path / "runtime.env"
    monkeypatch.setattr(sys, "argv", ["runtime_role", "--output", str(output)])
    runtime_role.main()
    assert output.stat().st_mode & 0o077 == 0
    url = output.read_text().strip().split("=", 1)[1]
    db = create_engine(url)
    try:
        with db.connect() as conn:
            assert conn.execute(text("SELECT COUNT(*) FROM projects")).scalar() >= 0
        for statement in [
            "CREATE TABLE forbidden_security_test (id integer)",
            "CREATE ROLE forbidden_security_role",
        ]:
            with db.begin() as conn:
                with pytest.raises(DBAPIError):
                    conn.execute(text(statement))
        # Idempotent provisioning does not rotate credentials under running instances.
        before = output.read_text()
        runtime_role.main()
        assert output.read_text() == before
    finally:
        db.dispose()


def test_runtime_role_refuses_membership_ownership_and_other_connection(
    client, monkeypatch, tmp_path
):
    if make_url(settings.DATABASE_URL).get_backend_name() != "postgresql":
        pytest.skip("Requires PostgreSQL role enforcement")
    output = tmp_path / "runtime-guard.env"
    monkeypatch.setattr(sys, "argv", ["runtime_role", "--output", str(output)])
    runtime_role.main()
    before = output.read_text()
    maintenance = create_engine(settings.DATABASE_URL)
    try:
        with maintenance.begin() as conn:
            conn.execute(text("CREATE ROLE security_membership_probe NOLOGIN"))
            conn.execute(text("GRANT security_membership_probe TO maibo_pm_runtime"))
        try:
            with pytest.raises(RuntimeError, match="memberships or owned objects"):
                runtime_role.main()
            assert output.read_text() == before
        finally:
            with maintenance.begin() as conn:
                conn.execute(text("REVOKE security_membership_probe FROM maibo_pm_runtime"))
                conn.execute(text("DROP ROLE security_membership_probe"))
        with maintenance.begin() as conn:
            conn.execute(text("CREATE TABLE security_ownership_probe (id integer)"))
            conn.execute(text("ALTER TABLE security_ownership_probe OWNER TO maibo_pm_runtime"))
        try:
            with pytest.raises(RuntimeError, match="memberships or owned objects"):
                runtime_role.main()
            assert output.read_text() == before
        finally:
            with maintenance.begin() as conn:
                conn.execute(text("DROP TABLE security_ownership_probe"))
        target = make_url(before.strip().split("=", 1)[1])
        other = target.set(port=(target.port or 5432) + 1)
        output.write_text(
            "PMS_RUNTIME_DATABASE_URL=" + other.render_as_string(hide_password=False) + "\n"
        )
        with pytest.raises(SystemExit, match="different database"):
            runtime_role.main()
    finally:
        output.write_text(before)
        maintenance.dispose()
