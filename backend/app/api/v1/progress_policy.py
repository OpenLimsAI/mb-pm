"""Read, explain, preview and atomically save a project's progress policy."""

import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.v1.task_collaboration import record_activity
from app.db.session import get_db
from app.models import AuditLog, Project, SubProject, Task, User
from app.services.rollup import (
    effective_weight,
    recompute_project,
    recompute_subproject,
    weighted_progress,
)
from app.services.scope import is_full_access, visible_project_ids_for, visible_task_ids_for

router = APIRouter(prefix="/projects", tags=["progress-policy"])
Db = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]
Weight = Annotated[
    Decimal, Field(ge=0, le=Decimal("999999.9999"), decimal_places=4, allow_inf_nan=False)
]


class WeightInput(BaseModel):
    task_id: str = Field(min_length=1, max_length=64)
    value: Weight | None


class PolicyInput(BaseModel):
    method: Literal["equal", "effort", "custom"]
    weights: list[WeightInput] = Field(default_factory=list, max_length=5000)
    fingerprint: str | None = Field(default=None, max_length=64)
    reason: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def unique_weights(self):
        if len({row.task_id for row in self.weights}) != len(self.weights):
            raise ValueError("同一任务的权重不能重复提交")
        return self

    def weight_map(self):
        return {row.task_id: row.value for row in self.weights}


def editable(user: User, project: Project) -> bool:
    return is_full_access(user) or (user.role == "project_lead" and project.owner_id == user.id)


def state(db: Session, user: User, project_id: str, *, write=False, lock=False):
    query = db.query(Project).filter_by(id=project_id)
    project = (query.with_for_update() if lock else query).first()
    if project is None or project_id not in visible_project_ids_for(user, db):
        raise HTTPException(404, "项目不存在或不可访问")
    if write and not editable(user, project):
        raise HTTPException(403, "仅管理员或项目负责人可修改进度计算规则")
    subs = db.query(SubProject).filter_by(project_id=project_id).order_by(SubProject.id).all()
    query = db.query(Task).filter(Task.sub_project_id.in_([s.id for s in subs])).order_by(Task.id)
    tasks = (query.with_for_update() if lock else query).all()
    return project, subs, tasks


def describe(project, subs, tasks, payload=None):
    method = payload.method if payload else project.progress_method
    overrides = payload.weight_map() if payload else {}
    if set(overrides) - {t.id for t in tasks}:
        raise HTTPException(422, "权重包含项目外或已删除的任务，请重新载入")
    result = weighted_progress(tasks, method, overrides)
    before = weighted_progress(tasks, project.progress_method)
    request = {"method": method, "weights": overrides}
    snapshot = {
        "method": project.progress_method,
        "owner": project.owner_id,
        "updated": project.updated_at,
        "subprojects": [(s.id, s.name) for s in subs],
        "tasks": [
            (
                t.id,
                t.sub_project_id,
                t.revision,
                t.name,
                t.code,
                t.progress,
                t.estimated_effort,
                t.progress_weight,
                t.is_milestone,
            )
            for t in tasks
        ],
        "request": request,
    }
    fingerprint = hashlib.sha256(
        json.dumps(snapshot, default=str, sort_keys=True).encode()
    ).hexdigest()
    rows = []
    for task in tasks:
        weight = effective_weight(
            task, method, overrides.get(task.id), overridden=task.id in overrides
        )
        share = float(weight) / result["denominator"] if result["denominator"] else 0
        custom = overrides.get(task.id) if task.id in overrides else task.progress_weight
        rows.append(
            {
                "task_id": task.id,
                "sub_project_id": task.sub_project_id,
                "code": task.code,
                "name": task.name,
                "progress": task.progress,
                "is_milestone": task.is_milestone,
                "estimated_effort": float(task.estimated_effort or 0),
                "custom_weight": float(custom) if custom is not None else None,
                "effective_weight": float(weight),
                "share": share,
                "contribution": task.progress * share,
            }
        )
    return {
        "project_id": project.id,
        "method": method,
        "current_method": project.progress_method,
        "stored_progress": project.progress,
        "before_progress": before["progress"],
        **result,
        "fingerprint": fingerprint,
        "changed": method != project.progress_method
        or any(t.id in overrides and overrides[t.id] != t.progress_weight for t in tasks),
        "rows": rows,
        "subprojects": [
            {
                "id": s.id,
                "name": s.name,
                **weighted_progress(
                    [t for t in tasks if t.sub_project_id == s.id], method, overrides
                ),
            }
            for s in subs
        ],
        "rules": {
            "equal": "所有任务含里程碑各计 1，与原等权计算一致。",
            "effort": "普通任务按预计工时计权；里程碑及预计工时为 0 的任务权重为 0。",
            "custom": "普通任务未设置时为 1；里程碑未设置时为 0。明确填写 0 表示不计入。",
            "formula": "Σ(任务进度 × 有效权重) ÷ Σ有效权重，四舍五入为整数；总权重为 0 时进度为 0。",
        },
    }


@router.get("/{project_id}/progress-policy")
def get_policy(project_id: str, db: Db, user: CurrentUser):
    project, subs, tasks = state(db, user, project_id)
    result = describe(project, subs, tasks)
    allowed = visible_task_ids_for(user, db)
    result["hidden_task_count"] = sum(t.id not in allowed for t in tasks)
    result["rows"] = [row for row in result["rows"] if row["task_id"] in allowed]
    visible_subs = {t.sub_project_id for t in tasks if t.id in allowed}
    result["subprojects"] = [row for row in result["subprojects"] if row["id"] in visible_subs]
    result["editable"] = editable(user, project)
    return result


@router.post("/{project_id}/progress-policy/preview")
def preview_policy(project_id: str, payload: PolicyInput, db: Db, user: CurrentUser):
    return describe(*state(db, user, project_id, write=True), payload)


@router.put("/{project_id}/progress-policy")
def save_policy(project_id: str, payload: PolicyInput, db: Db, user: CurrentUser):
    if not payload.reason.strip():
        raise HTTPException(422, "请填写修改计算规则的原因")
    project, subs, tasks = state(db, user, project_id, write=True, lock=True)
    result = describe(project, subs, tasks, payload)
    if payload.fingerprint != result["fingerprint"]:
        raise HTTPException(409, "任务、进度或计算规则已变化，请重新预览后保存")
    if not result["changed"]:
        return result
    changes = []
    overrides = payload.weight_map()
    for task in tasks:
        if task.id in overrides and task.progress_weight != overrides[task.id]:
            old = task.progress_weight
            task.progress_weight = overrides[task.id]
            change = {
                "before": float(old) if old is not None else None,
                "after": float(task.progress_weight) if task.progress_weight is not None else None,
            }
            changes.append({"task_id": task.id, **change})
            record_activity(
                db,
                task,
                user,
                "change",
                f"调整进度权重：{payload.reason.strip()}",
                {"progress_weight": change},
            )
    before_method = project.progress_method
    project.progress_method = payload.method
    project.updated_at = datetime.now(UTC)
    db.add(
        AuditLog(
            id=f"log-{uuid4().hex[:12]}",
            actor_id=user.id,
            action="修改进度计算规则",
            target="项目",
            target_id=project_id,
            created_at=datetime.now(UTC),
            detail=json.dumps(
                {
                    "reason": payload.reason.strip(),
                    "before_method": before_method,
                    "after_method": payload.method,
                    "weights": changes,
                    "before_progress": result["before_progress"],
                    "progress": result["progress"],
                },
                ensure_ascii=False,
                default=str,
            ),
        )
    )
    db.flush()
    for sub in subs:
        recompute_subproject(db, sub.id)
    recompute_project(db, project.id)
    db.commit()
    return result
