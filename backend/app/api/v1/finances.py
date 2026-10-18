"""ProjectFinances API —— 项目预算（组合预算聚合用），按当前用户可见项目收窄。

路由：
    GET  /api/v1/finances                可见项目的预算；「已花费」由任务实际花费实时汇总
    PUT  /api/v1/finances/{project_id}   设置 / 修改项目预算，写审计日志
权限与项目「编辑项目」（编辑模式 + 预算）一致：admin / cmc_lead；旧角色 project_lead 仅限本人负责 / 参与的项目。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import Project, ProjectFinance, User
from app.schemas.finance import ProjectFinanceOut, ProjectFinanceUpdate
from app.services.finance import finance_view, task_cost_totals, update_finance
from app.services.scope import is_full_access, visible_project_ids_for

router = APIRouter(prefix="/finances", tags=["finances"])


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
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    if db.query(Project).filter_by(id=project_id).with_for_update().first() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    if not is_full_access(user) and project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只能修改本人负责或参与的项目的预算")
    finance, _ = update_finance(db, project_id, payload, user)
    db.commit()
    return finance_view(finance, task_cost_totals(db, [project_id]))
