"""Named business CHECKs; validation never changes existing customer records."""

from sqlalchemy import CheckConstraint, inspect, text

TASK_STATES = "status IN ('未开始','进行中','阻塞','延迟','已完成','已验证')"
CONSTRAINTS = {
    "tasks": {
        "ck_tasks_status": TASK_STATES,
        "ck_tasks_priority": "priority IN ('高','中','低')",
        "ck_tasks_progress": "progress BETWEEN 0 AND 100",
        "ck_tasks_planned_dates": "planned_end >= planned_start",
        "ck_tasks_actual_dates": "actual_start IS NULL OR actual_end IS NULL OR actual_end >= actual_start",
        "ck_tasks_effort": "estimated_effort BETWEEN 0 AND 9999.99 AND (actual_effort IS NULL OR actual_effort BETWEEN 0 AND 9999.99)",
        "ck_tasks_cost": "(cost_budget IS NULL OR cost_budget BETWEEN 0 AND 99999999) AND (actual_cost IS NULL OR actual_cost BETWEEN 0 AND 99999999)",
    },
    "sub_projects": {
        "ck_sub_projects_status": TASK_STATES,
        "ck_sub_projects_progress": "progress BETWEEN 0 AND 100",
    },
    "projects": {
        "ck_projects_status": "status IN ('活跃','暂停','已完成','已归档')",
        "ck_projects_health": "health IN ('green','yellow','red')",
        "ck_projects_progress": "progress BETWEEN 0 AND 100",
        "ck_projects_planned_dates": "planned_end >= planned_start",
    },
    "project_finances": {
        "ck_project_finances_amounts": "total_budget BETWEEN 0 AND 99999999 AND committed BETWEEN 0 AND 99999999",
    },
}


def table_constraints(table):
    return tuple(CheckConstraint(sql, name=name) for name, sql in CONSTRAINTS[table].items())


def violations(connection):
    """Counts only, with no record bodies or customer identifiers in diagnostics."""
    result = {}
    existing = set(inspect(connection).get_table_names())
    for table, checks in CONSTRAINTS.items():
        if table not in existing:
            continue
        for name, sql in checks.items():
            count = connection.execute(
                text(f'SELECT COUNT(*) FROM "{table}" WHERE NOT ({sql})')
            ).scalar_one()
            if count:
                result[name] = count
    return result


def apply_postgres(connection):
    bad = violations(connection)
    if bad:
        raise RuntimeError(f"业务约束检查失败（仅计数），未修改历史数据：{bad}")
    inspector = inspect(connection)
    existing_tables = set(inspector.get_table_names())
    for table, checks in CONSTRAINTS.items():
        if table not in existing_tables:
            continue
        existing = {check["name"] for check in inspector.get_check_constraints(table)}
        for name, sql in checks.items():
            if name not in existing:
                connection.execute(
                    text(f'ALTER TABLE "{table}" ADD CONSTRAINT "{name}" CHECK ({sql}) NOT VALID')
                )
            connection.execute(text(f'ALTER TABLE "{table}" VALIDATE CONSTRAINT "{name}"'))
