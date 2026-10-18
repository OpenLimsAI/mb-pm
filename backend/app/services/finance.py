"""项目财务口径：「已花费」= 该项目全部任务的实际花费之和（实时汇总，万元）。

任务成本（成本预算 / 实际花费）不含内部人力，只含外包、耗材、CRO 等；项目「已花费」与之同口径。
总预算、已承诺、成本结构仍在项目级手工维护。
"""

import json
from collections.abc import Iterable
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLog, ProjectFinance, SubProject, Task, User
from app.schemas.finance import ProjectFinanceUpdate


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


AUDITED = ("total_budget", "committed", "breakdown", "fiscal_year", "notes")


def update_finance(
    db: Session, project_id: str, payload: ProjectFinanceUpdate, user: User
) -> tuple[ProjectFinance, bool]:
    """写入预算及审计记录；由调用方提交，支持与项目结构原子保存。"""
    finance = db.get(ProjectFinance, project_id)
    before = {k: _plain(getattr(finance, k)) for k in AUDITED} if finance else None
    if finance is None:
        finance = ProjectFinance(project_id=project_id, spent=0)
        db.add(finance)
    for key, value in payload.model_dump().items():
        setattr(finance, key, value)
    after = payload.model_dump()
    changes = {
        k: [before[k] if before else None, after[k]]
        for k in AUDITED
        if not before or _differs(before[k], after[k])
    }
    if changes:
        db.add(
            AuditLog(
                id=f"log-{uuid4().hex[:12]}",
                actor_id=user.id,
                action="项目预算变更" if before else "设置项目预算",
                target="项目预算",
                target_id=project_id[:40],
                detail=json.dumps(
                    {"project_id": project_id, "changes": changes}, ensure_ascii=False, default=str
                ),
                created_at=datetime.now(UTC),
            )
        )
    return finance, bool(changes)


def _plain(value):
    """Decimal 金额转成与请求体一致的 float，便于比较与写入审计明细。"""
    return round(float(value), 2) if isinstance(value, Decimal) else value


def _differs(old, new) -> bool:
    if isinstance(new, float):
        return old is None or round(float(old), 2) != new
    return old != new
