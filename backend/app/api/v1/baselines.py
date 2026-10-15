"""ProjectBaselines API —— 计划基线快照与版本对标。

路由：
    GET    /api/v1/baselines               当前用户可见项目的基线（admin / cmc_lead 为全部）
    POST   /api/v1/baselines               设立基线（后端按当前 DB 状态构建快照）
    DELETE /api/v1/baselines/{id}
"""

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import Project, ProjectBaseline, ProjectFinance, SubProject, Task, User
from app.schemas.baseline import BaselineCreate, BaselineOut
from app.services.rollup import live_span
from app.services.scope import is_full_access, visible_project_ids_for

router = APIRouter(prefix="/baselines", tags=["baselines"])


def _ensure_project_visible(user: User, db: Session, project_id: str) -> None:
    """project_lead 只能管理自己负责 / 参与的项目的基线。"""
    if not is_full_access(user) and project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "project not visible")


def _build_snapshot(db: Session, project: Project) -> dict:
    """按当前 DB 状态构建项目计划快照（键统一 camelCase，便于前端直接消费）。"""
    sub_ids = [s.id for s in db.query(SubProject).filter_by(project_id=project.id).all()]
    tasks = db.query(Task).filter(Task.sub_project_id.in_(sub_ids)).all() if sub_ids else []
    fin = db.query(ProjectFinance).filter_by(project_id=project.id).first()

    milestones = [
        {
            "id": t.id,
            "code": t.code,
            "name": t.name,
            "plannedStart": t.planned_start.isoformat(),
            "plannedEnd": t.planned_end.isoformat(),
            "isCriticalPath": t.is_critical_path,
        }
        for t in tasks
        if t.is_milestone
    ]
    milestones.sort(key=lambda m: m["plannedEnd"])

    start, end = live_span(db, [project])[project.id]  # 与页首一致：按任务实时派生
    return {
        "projectPlannedStart": start.isoformat(),
        "projectPlannedEnd": end.isoformat(),
        "progress": project.progress,
        "totalBudget": float(fin.total_budget) if fin else 0.0,
        "taskCount": len(tasks),
        "milestoneCount": len(milestones),
        "milestones": milestones,
    }


@router.get("", response_model=list[BaselineOut])
def list_baselines(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(ProjectBaseline)
    if not is_full_access(user):
        q = q.filter(ProjectBaseline.project_id.in_(visible_project_ids_for(user, db)))
    rows = q.order_by(ProjectBaseline.created_at.desc()).all()
    return [BaselineOut.model_validate(b) for b in rows]


@router.post("", response_model=BaselineOut, status_code=status.HTTP_201_CREATED)
def create_baseline(
    payload: BaselineCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    project = db.query(Project).filter_by(id=payload.project_id).first()
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    _ensure_project_visible(user, db, project.id)

    obj = ProjectBaseline(
        id=f"bl-{uuid4().hex[:10]}",
        project_id=project.id,
        label=payload.label,
        reason=payload.reason,
        snapshot=_build_snapshot(db, project),
        created_by=user.id,
        created_at=datetime.now(timezone.utc),
    )
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return BaselineOut.model_validate(obj)


@router.delete("/{baseline_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_baseline(
    baseline_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    obj = db.query(ProjectBaseline).filter_by(id=baseline_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "baseline not found")
    _ensure_project_visible(user, db, obj.project_id)
    db.delete(obj)
    db.commit()
