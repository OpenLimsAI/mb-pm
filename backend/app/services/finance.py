"""项目财务口径：「已花费」= 该项目全部任务的实际花费之和（实时汇总，万元）。

任务成本（成本预算 / 实际花费）不含内部人力，只含外包、耗材、CRO 等；项目「已花费」与之同口径。
总预算、已承诺、成本结构仍在项目级手工维护。
"""

from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ProjectFinance, SubProject, Task


def task_cost_totals(
    db: Session, project_ids: Iterable[str] | None = None
) -> dict[str, tuple[float, float]]:
    """{项目 ID: (任务预算合计, 任务实际花费合计)}；没有任务的项目不出现在结果中。"""
    stmt = (
        select(
            SubProject.project_id,
            func.coalesce(func.sum(Task.cost_budget), 0),
            func.coalesce(func.sum(Task.actual_cost), 0),
        )
        .join(Task, Task.sub_project_id == SubProject.id)
        .group_by(SubProject.project_id)
    )
    if project_ids is not None:
        stmt = stmt.where(SubProject.project_id.in_(list(project_ids)))
    return {
        project_id: (round(float(budget), 2), round(float(actual), 2))
        for project_id, budget, actual in db.execute(stmt)
    }


def finance_view(finance: ProjectFinance, totals: dict[str, tuple[float, float]]) -> dict:
    """对外的项目财务：已花费取任务实际花费合计，并附任务预算合计。"""
    task_budget, spent = totals.get(finance.project_id, (0.0, 0.0))
    return {
        "project_id": finance.project_id,
        "total_budget": round(float(finance.total_budget or 0), 2),
        "spent": spent,
        "committed": round(float(finance.committed or 0), 2),
        "breakdown": finance.breakdown or {},
        "fiscal_year": finance.fiscal_year,
        "notes": finance.notes,
        "task_budget": task_budget,
    }
