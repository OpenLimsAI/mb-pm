"""ProjectFinances API —— 项目预算（组合预算聚合用），按当前用户可见项目收窄。

路由：
    GET  /api/v1/finances                可见项目的预算；「已花费」由任务实际花费实时汇总
    PUT  /api/v1/finances/{project_id}   设置 / 修改项目预算（admin / cmc_lead），写审计日志
"""

import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import AuditLog, Project, ProjectFinance, User
from app.schemas.finance import ProjectFinanceOut, ProjectFinanceUpdate
from app.services.finance import finance_view, task_cost_totals
from app.services.scope import is_full_access, visible_project_ids_for

router = APIRouter(prefix="/finances", tags=["finances"])
AUDITED = ("total_budget", "committed", "breakdown", "fiscal_year", "notes")


@router.get("", response_model=list[ProjectFinanceOut])
def list_finances(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(ProjectFinance)
    visible = None if is_full_access(user) else visible_project_ids_for(user, db)
    if visible is not None:
        q = q.filter(ProjectFinance.project_id.in_(visible))
    rows = q.all()
    totals = task_cost_totals(db, [f.project_id for f in rows])
    return [finance_view(f, totals) for f in rows]


@router.put("/{project_id}", response_model=ProjectFinanceOut)
def upsert_finance(
    project_id: str,
    payload: ProjectFinanceUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
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
    db.commit()
    return finance_view(finance, task_cost_totals(db, [project_id]))


def _plain(value):
    """Decimal 金额转成与请求体一致的 float，便于比较与写入审计明细。"""
    return round(float(value), 2) if isinstance(value, Decimal) else value


def _differs(old, new) -> bool:
    if isinstance(new, float):
        return old is None or round(float(old), 2) != new
    return old != new
