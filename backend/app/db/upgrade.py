"""Run once with the schema-owner credential; never in the runtime container lifecycle."""

from sqlalchemy import text

from app.db.business_constraints import apply_postgres, violations
from app.main import Base, _backfill_task_order, _backfill_team_members, _ensure_schema, engine


def main(*, schema_only: bool = False):
    # Session-level advisory lock serializes concurrent deploy commands, not app workers.
    with engine.connect() as guard:
        postgres = engine.dialect.name == "postgresql"
        if postgres:
            guard.execute(text("SELECT pg_advisory_lock(7211202602)"))
            guard.commit()
        try:
            bad = violations(guard)
            if bad:
                raise RuntimeError(f"业务约束检查失败（仅计数），未修改历史数据：{bad}")
            guard.commit()
            Base.metadata.create_all(bind=engine)
            _ensure_schema()
            if not schema_only:
                _backfill_task_order()
                _backfill_team_members()
            if postgres:
                with engine.begin() as conn:
                    apply_postgres(conn)
            print("schema upgrade complete")
        finally:
            if postgres:
                guard.execute(text("SELECT pg_advisory_unlock(7211202602)"))
                guard.commit()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--schema-only",
        action="store_true",
        help="Only add schema/constraints; preserve existing task order and project membership.",
    )
    main(schema_only=parser.parse_args().schema_only)
