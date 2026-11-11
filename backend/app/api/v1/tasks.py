"""Tasks API — Level 3 任务（叶子节点）。

路由：
    GET    /api/v1/tasks                       分页 + 过滤（自动 scope 收窄）
    POST   /api/v1/tasks                       创建（admin/cmc_lead/project_lead）
    GET    /api/v1/tasks/{id}
    PATCH  /api/v1/tasks/{id}                  状态变更受 task.update / task.update.own 双轨控制
    DELETE /api/v1/tasks/{id}                  删除（admin/cmc_lead/project_lead）

权限矩阵参考前端 lib/permissions.ts：
  admin/cmc_lead/project_lead → 全字段更新（project_lead 仅限自己负责 / 参与的项目）
  rd/production/qa_qc         → 仅能改本人 owner 或 collaborator 的任务
任务只能派给项目团队里的人（新建、改负责人、加协作人），规则见 services/team.py。
"""

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.api.v1.task_collaboration import (
    invalidate_acceptance,
    lock_task_for_update,
    record_activity,
)
from app.db.session import get_db
from app.models import AuditLog, Project, SubProject, Task, User
from app.models.task_collaboration import TaskAcceptance
from app.schemas.business_values import validate_date_patch
from app.schemas.common import Page, PageMeta
from app.schemas.task import TaskCreate, TaskOut, TaskUpdate
from app.services.rollup import recompute_project, recompute_subproject, rollup_for_task
from app.services.scope import (
    is_full_access,
    is_own_task_only,
    visible_project_ids_for,
    visible_task_ids_for,
)
from app.services.task_order import next_sort_order
from app.services.team import ensure_in_team

router = APIRouter(prefix="/tasks", tags=["tasks"])


# 执行层（rd / production / qa_qc）更新自己任务时不能改的字段 → 提示用名称
EXECUTOR_PROTECTED = {
    "owner_id": "负责人",
    "is_critical_path": "关键路径标记",
    "is_milestone": "里程碑标记",
    "planned_start": "计划开始",
    "planned_end": "计划结束",
    "cost_budget": "任务预算",
}


def _json_value(value):
    if isinstance(value, date | datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _can_user_modify_task(user: User, task: Task) -> bool:
    """判定 user 是否能改这个 task。"""
    if user.role in ("admin", "cmc_lead", "project_lead"):
        return True
    # rd / production / qa_qc：仅 owner 或 collaborator
    if user.role in ("rd", "production", "qa_qc"):
        if task.owner_id == user.id:
            return True
        if task.collaborator_ids and user.id in task.collaborator_ids:
            return True
    return False


@router.get("", response_model=Page[TaskOut])
def list_tasks(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=5000),
    project_id: str | None = None,
    sub_project_id: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    owner_id: str | None = None,
    is_milestone: bool | None = None,
    is_critical_path: bool | None = None,
    keyword: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(Task)

    # —— 行级权限 —— #
    if not is_full_access(user):
        visible_ids = visible_task_ids_for(user, db)
        if not visible_ids:
            return Page[TaskOut](items=[], meta=PageMeta(page=page, page_size=page_size, total=0))
        q = q.filter(Task.id.in_(visible_ids))

    # —— 业务过滤 —— #
    if project_id:
        # 通过 sub_project 关联到 project_id
        sub_ids = [s.id for s in db.query(SubProject).filter_by(project_id=project_id).all()]
        q = q.filter(Task.sub_project_id.in_(sub_ids))
    if sub_project_id:
        q = q.filter(Task.sub_project_id == sub_project_id)
    if status_filter:
        q = q.filter(Task.status == status_filter)
    if owner_id:
        q = q.filter(Task.owner_id == owner_id)
    if is_milestone is not None:
        q = q.filter(Task.is_milestone == is_milestone)
    if is_critical_path is not None:
        q = q.filter(Task.is_critical_path == is_critical_path)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(Task.code.ilike(like), Task.name.ilike(like)))

    total = q.count()
    items = q.order_by(Task.planned_start).offset((page - 1) * page_size).limit(page_size).all()

    return Page[TaskOut](
        items=[TaskOut.model_validate(t) for t in items],
        meta=PageMeta(page=page, page_size=page_size, total=total),
    )


@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    obj = create_task_record(payload, db, user)
    db.commit()
    db.refresh(obj)
    return TaskOut.model_validate(obj)


def create_task_record(payload: TaskCreate, db: Session, user: User) -> Task:
    """Create and roll up a task inside the caller's transaction."""
    if not payload.id:
        payload.id = f"tk-{uuid4().hex[:10]}"

    # 校验 sub_project 在可见范围
    sub = db.query(SubProject).filter_by(id=payload.sub_project_id).first()
    if not sub:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "sub_project not found")
    if sub.project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "sub_project not visible")
    db.query(Project).filter_by(id=sub.project_id).with_for_update().one()
    ensure_in_team(
        db, db.get(Project, sub.project_id), [payload.owner_id, *(payload.collaborator_ids or [])]
    )

    if payload.sort_order is None:
        payload.sort_order = next_sort_order(db, sub.id)
    obj = Task(**payload.model_dump())
    db.add(obj)
    # 新增任务（含里程碑）后，重算所属子项目/项目进度，保持汇总一致。
    db.flush()
    rollup_for_task(db, obj)
    return obj


def apply_task_create(db: Session, user: User, payload: TaskCreate) -> Task:
    """Keep reviewed PM drafts on the shared transactional create path."""
    return create_task_record(payload, db, user)


@router.get("/{task_id}", response_model=TaskOut)
def get_task(
    task_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    task = db.query(Task).filter_by(id=task_id).first()
    if not task:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    # 行级权限校验
    if not is_full_access(user):
        if task.id not in visible_task_ids_for(user, db):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "no access")
    return TaskOut.model_validate(task)


@router.patch("/{task_id}", response_model=TaskOut)
def update_task(
    task_id: str,
    payload: TaskUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    task = update_task_record(task_id, payload, db, user)
    db.commit()
    db.refresh(task)
    return TaskOut.model_validate(task)


def update_task_record(task_id: str, payload: TaskUpdate, db: Session, user: User) -> Task:
    """Validate task scope, version, and rollups in the caller's transaction."""
    task = lock_task_for_update(db, task_id)
    if not task:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")

    if not _can_user_modify_task(user, task):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "rd / production / qa_qc 仅能更新自己负责或参与的任务",
        )

    # project_lead 仅能改自己负责 / 参与的项目内的任务（与新建 / 删除同一口径）
    if not is_full_access(user) and not is_own_task_only(user):
        sub = db.query(SubProject).filter_by(id=task.sub_project_id).first()
        if not sub or sub.project_id not in visible_project_ids_for(user, db):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "no access")

    # 限制：执行者不能改 owner / 关键标志 / 里程碑 / 计划日期 / 任务预算（实际花费可录入）
    if is_own_task_only(user):
        provided = payload.model_dump(exclude_unset=True).keys()
        forbidden = [label for field, label in EXECUTOR_PROTECTED.items() if field in provided]
        if forbidden:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"执行层不能修改任务的{'、'.join(forbidden)}，请联系项目负责人",
            )

    # 新的负责人 / 协作人须已在项目团队中（沿用原来的不受影响）
    if payload.expected_revision is not None and task.revision != payload.expected_revision:
        raise HTTPException(
            409,
            {
                "message": "任务已被其他人修改，请比较最新数据后重新应用草稿",
                "current": TaskOut.model_validate(task).model_dump(mode="json"),
            },
        )
    changes = payload.model_dump(exclude_unset=True, exclude={"expected_revision", "progress_note"})
    acceptance = db.get(TaskAcceptance, task.id)
    if (
        changes.get("status") == "已验证"
        and acceptance
        and (acceptance.state != "accepted" or task.status != "已验证")
    ):
        raise HTTPException(422, "此里程碑须由指定验收人验收，不能直接标记已验证")
    added = set()
    if changes.get("owner_id") and changes["owner_id"] != task.owner_id:
        added.add(changes["owner_id"])
    if changes.get("collaborator_ids"):
        added |= set(changes["collaborator_ids"]) - set(task.collaborator_ids or [])
    if added:
        sub = db.query(SubProject).filter_by(id=task.sub_project_id).first()
        ensure_in_team(db, db.get(Project, sub.project_id), added)

    validate_date_patch(task, changes)
    old_status = task.status
    actual_changes = {
        k: {"before": _json_value(getattr(task, k)), "after": _json_value(v)}
        for k, v in changes.items()
        if getattr(task, k) != v
    }
    if actual_changes:
        invalidate_acceptance(db, task, user)
    for k, v in changes.items():
        setattr(task, k, v)
    # A changed accepted milestone must be submitted again, even when the caller retained its old status.
    if actual_changes and acceptance and acceptance.state == "draft" and task.status == "已验证":
        task.status = "已完成"
    if task.status != old_status:
        actual_changes["status"] = {"before": old_status, "after": task.status}
    note = (payload.progress_note or "").strip()
    if note and not actual_changes:
        task.revision += 1
    if actual_changes or note:
        record_activity(db, task, user, "progress" if note else "change", note, actual_changes)
    if note:
        db.add(
            AuditLog(
                id=f"log-{uuid4().hex[:12]}",
                actor_id=user.id,
                action="任务进展说明",
                target="任务",
                target_id=task.id,
                detail=note,
                created_at=datetime.now(UTC),
            )
        )
    if actual_changes:
        db.add(
            AuditLog(
                id=f"log-{uuid4().hex[:12]}",
                actor_id=user.id,
                action="任务字段变更",
                target="任务",
                target_id=task.id,
                detail=json.dumps(actual_changes, ensure_ascii=False),
                created_at=datetime.now(UTC),
            )
        )

    # 状态变更钩子 → 写审计日志
    if task.status != old_status:
        db.add(
            AuditLog(
                id=f"log-{uuid4().hex[:12]}",
                actor_id=user.id,
                action="任务状态变更",
                target="任务",
                target_id=task.id,
                detail=f"{old_status} → {task.status}",
                created_at=datetime.now(UTC),
            )
        )

    # 进度汇总：任务变更后自动重算子项目 + 项目进度
    db.flush()
    rollup_for_task(db, task)
    return task


def apply_task_update(db: Session, user: User, task_id: str, payload: TaskUpdate) -> Task:
    """Keep reviewed PM drafts on the shared transactional update path."""
    return update_task_record(task_id, payload, db, user)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    task = lock_task_for_update(db, task_id)
    if not task:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    sub = db.query(SubProject).filter_by(id=task.sub_project_id).first()
    if not is_full_access(user):
        # project_lead 仅能删自己项目的
        if not sub or sub.project_id not in visible_project_ids_for(user, db):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "no access")
    sub_id = task.sub_project_id
    project_id = sub.project_id if sub else None
    db.delete(task)
    # 删除任务（含里程碑）后，重算所属子项目/项目进度，避免汇总残留已删任务。
    db.flush()
    recompute_subproject(db, sub_id)
    if project_id:
        recompute_project(db, project_id)
    db.commit()
