"""ProjectBaselines API —— 计划基线快照与版本对标。

路由：
    GET    /api/v1/baselines               全部基线（CTO 组合视角）
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

router = APIRouter(prefix="/baselines", tags=["baselines"])


def _build_snapshot(db: Session, project: Project) -> dict:
    """按当前 DB 状态构建项目计划快照（键统一 camelCase，便于前端直接消费）。"""
    sub_ids = [s.id for s in db.query(SubProject).filter_by(project_id=project.id).all()]
    tasks = (
        db.query(Task).filter(Task.sub_project_id.in_(sub_ids)).all() if sub_ids else []
    )
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

    return {
        "projectPlannedStart": project.planned_start.isoformat(),
        "projectPlannedEnd": project.planned_end.isoformat(),
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
    rows = (
        db.query(ProjectBaseline)
        .order_by(ProjectBaseline.created_at.desc())
        .all()
    )
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
    db.delete(obj)
    db.commit()
