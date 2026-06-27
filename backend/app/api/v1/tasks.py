"""Tasks API — Level 3 任务（叶子节点）。

路由：
    GET    /api/v1/tasks                       分页 + 过滤（自动 scope 收窄）
    POST   /api/v1/tasks                       创建（admin/cmc_lead/project_lead）
    GET    /api/v1/tasks/{id}
    PATCH  /api/v1/tasks/{id}                  状态变更受 task.update / task.update.own 双轨控制
    DELETE /api/v1/tasks/{id}                  删除（admin/cmc_lead/project_lead）

权限矩阵参考前端 lib/permissions.ts：
  admin/cmc_lead/project_lead → 全字段更新
  rd/production/qa_qc         → 仅能改本人 owner 或 collaborator 的任务
"""

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import AuditLog, SubProject, Task, User
from app.schemas.common import Page, PageMeta
from app.schemas.task import TaskCreate, TaskOut, TaskUpdate
from app.services.rollup import recompute_project, recompute_subproject, rollup_for_task
from app.services.scope import (
    is_full_access,
    is_own_task_only,
    visible_project_ids_for,
    visible_task_ids_for,
)

router = APIRouter(prefix="/tasks", tags=["tasks"])


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
    if not payload.id:
        payload.id = f"tk-{uuid4().hex[:10]}"

    # 校验 sub_project 在可见范围
    sub = db.query(SubProject).filter_by(id=payload.sub_project_id).first()
    if not sub:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "sub_project not found")
    if sub.project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "sub_project not visible")

    obj = Task(**payload.model_dump())
    db.add(obj)
    # 新增任务（含里程碑）后，重算所属子项目/项目进度，保持汇总一致。
    db.flush()
    rollup_for_task(db, obj)
    db.commit()
    db.refresh(obj)
    return TaskOut.model_validate(obj)


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
    task = db.query(Task).filter_by(id=task_id).first()
    if not task:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")

    if not _can_user_modify_task(user, task):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "rd / production / qa_qc 仅能更新自己负责或参与的任务",
        )

    # 限制：执行者不能改 owner / 关键标志 / 里程碑 / 计划日期
    if is_own_task_only(user):
        protected = {
            "owner_id",
            "is_critical_path",
            "is_milestone",
            "planned_start",
            "planned_end",
        }
        provided = payload.model_dump(exclude_unset=True).keys()
        forbidden = protected & set(provided)
        if forbidden:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"executor cannot modify fields: {', '.join(sorted(forbidden))}",
            )

    old_status = task.status
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(task, k, v)

    # 状态变更钩子 → 写审计日志
    if payload.status and payload.status != old_status:
        db.add(
            AuditLog(
                id=f"log-{uuid4().hex[:12]}",
                actor_id=user.id,
                action="任务状态变更",
                target="任务",
                target_id=task.id,
                detail=f"{old_status} → {payload.status}",
                created_at=datetime.now(timezone.utc),
            )
        )

    # 进度汇总：任务变更后自动重算子项目 + 项目进度
    db.flush()
    rollup_for_task(db, task)

    db.commit()
    db.refresh(task)
    return TaskOut.model_validate(task)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    task = db.query(Task).filter_by(id=task_id).first()
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
