"""Reject invalid business values without rewriting historic rows."""

import sqlalchemy as sa

from alembic import op
from app.db.business_constraints import CONSTRAINTS, apply_postgres, violations

revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        apply_postgres(connection)
        return
    bad = violations(connection)
    if bad:
        raise RuntimeError(f"业务约束检查失败，未修改历史数据：{bad}")
    inspector = sa.inspect(connection)
    for table, checks in CONSTRAINTS.items():
        if table not in inspector.get_table_names():
            continue
        existing = {item["name"] for item in inspector.get_check_constraints(table)}
        missing = {name: sql for name, sql in checks.items() if name not in existing}
        if missing:
            with op.batch_alter_table(table) as batch:
                for name, sql in missing.items():
                    batch.create_check_constraint(name, sql)


def downgrade():
    inspector = sa.inspect(op.get_bind())
    for table, checks in reversed(list(CONSTRAINTS.items())):
        if table not in inspector.get_table_names():
            continue
        existing = {item["name"] for item in inspector.get_check_constraints(table)}
        with op.batch_alter_table(table) as batch:
            for name in checks:
                if name in existing:
                    batch.drop_constraint(name, type_="check")
