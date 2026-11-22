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

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import SubProject, Task, User
from app.schemas.common import Page, PageMeta, list_snapshot
from app.schemas.task import TaskCreate, TaskOut, TaskUpdate
from app.services.rollup import recompute_project, recompute_subproject
from app.services.scope import (
    is_full_access,
    visible_project_ids_for,
    visible_task_ids_for,
)
from app.services.task_collaboration_service import lock_task_for_update
from app.services.task_records import (  # noqa: F401
    EXECUTOR_PROTECTED,
    _can_user_modify_task,
    _json_value,
    apply_task_create,
    apply_task_update,
    create_task_record,
    update_task_record,
)

router = APIRouter(prefix="/tasks", tags=["tasks"])


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
    consistent: bool = False,
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

    ordered = q.order_by(Task.planned_start, Task.id)
    offset = (page - 1) * page_size
    snapshot = None
    if consistent:
        ids = [row.id for row in ordered.with_entities(Task.id)]
        total = len(ids)
        snapshot = list_snapshot(ids) if total > page_size else None
        items = ordered.filter(Task.id.in_(ids[offset : offset + page_size])).all()
    else:
        total = q.count()
        items = ordered.offset(offset).limit(page_size).all()

    return Page[TaskOut](
        items=[TaskOut.model_validate(t) for t in items],
        meta=PageMeta(page=page, page_size=page_size, total=total, snapshot=snapshot),
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
