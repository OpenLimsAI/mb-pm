"""Provision PM's DML-only role with maintenance credentials, writing only a 0600 server file."""

import argparse
import os
import secrets
from pathlib import Path

from psycopg import sql
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from app.core.config import settings

ROLE = "maibo_pm_runtime"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    source = make_url(settings.DATABASE_URL)
    if source.get_backend_name() != "postgresql":
        raise SystemExit("PostgreSQL maintenance connection required")
    if args.output.exists():
        if args.output.stat().st_mode & 0o077:
            raise SystemExit("Runtime environment must be private (0600)")
        existing = args.output.read_text().strip().removeprefix("PMS_RUNTIME_DATABASE_URL=")
        target = make_url(existing)
        if (
            target.username != ROLE
            or target.set(username=source.username, password=source.password) != source
            or not target.password
        ):
            raise SystemExit("Existing runtime configuration is for a different database")
        password = target.password
    else:
        password = secrets.token_urlsafe(48)
        target = source.set(username=ROLE, password=password)
    engine = create_engine(source)
    with engine.begin() as conn:
        cursor = conn.connection.driver_connection.cursor()
        cursor.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (ROLE,))
        verb = "ALTER" if cursor.fetchone() else "CREATE"
        if verb == "ALTER":
            # NOINHERIT alone does not prevent SET ROLE. Never repurpose a role
            # with memberships/ownership, which could retain a privilege path.
            cursor.execute(
                "SELECT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=%s)), "
                "EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=(SELECT oid FROM pg_roles WHERE rolname=%s) AND deptype='o')",
                (ROLE, ROLE),
            )
            if any(cursor.fetchone()):
                raise RuntimeError(
                    "Existing runtime role has role memberships or owned objects; manual review required"
                )
        cursor.execute(
            sql.SQL(
                verb
                + " ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {}"
            ).format(sql.Identifier(ROLE), sql.Literal(password))
        )
        cursor.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                sql.Identifier(source.database), sql.Identifier(ROLE)
            )
        )
        cursor.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        cursor.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(ROLE)))
        cursor.execute(
            sql.SQL(
                "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {}"
            ).format(sql.Identifier(ROLE))
        )
        cursor.execute(
            sql.SQL("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {}").format(
                sql.Identifier(ROLE)
            )
        )
        cursor.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
            ).format(sql.Identifier(ROLE))
        )
        cursor.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {}"
            ).format(sql.Identifier(ROLE))
        )
        cursor.execute(
            sql.SQL("ALTER ROLE {} SET statement_timeout = '30s'").format(sql.Identifier(ROLE))
        )
        cursor.execute(
            sql.SQL("ALTER ROLE {} SET idle_in_transaction_session_timeout = '60s'").format(
                sql.Identifier(ROLE)
            )
        )
        cursor.close()
    restricted = create_engine(target)
    with restricted.connect() as conn:
        from sqlalchemy import text

        flags = conn.execute(
            text(
                "SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,has_schema_privilege(current_user,'public','CREATE') FROM pg_roles WHERE rolname=current_user"
            )
        ).one()
        if any(flags):
            raise RuntimeError("Runtime role still has elevated privileges")
        conn.execute(text("SELECT id FROM projects LIMIT 0"))
    temporary = args.output.with_suffix(".tmp")
    with temporary.open("x") as output:
        output.write(
            "PMS_RUNTIME_DATABASE_URL=" + target.render_as_string(hide_password=False) + "\n"
        )
    temporary.replace(args.output)
    print("Runtime role verified: DML only; private configuration saved")


if __name__ == "__main__":
    main()
