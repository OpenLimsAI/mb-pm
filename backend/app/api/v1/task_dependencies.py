"""TaskDependencies API — FS / SS / FF / SF + lag。

路由：
    GET    /api/v1/task-dependencies                    分页（按 project / task 过滤）
    POST   /api/v1/task-dependencies                    创建（admin/cmc_lead/project_lead）
    DELETE /api/v1/task-dependencies/{id}               删除
"""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.api.v1.task_collaboration import invalidate_acceptance, record_activity
from app.db.session import get_db
from app.models import Project, SubProject, Task, TaskDependency, User
from app.schemas.task import TaskDependencyCreate, TaskDependencyOut
from app.services.dependency_graph import lock_dependency_graph, validate_dependency_changes
from app.services.scope import visible_project_ids_for, visible_task_ids_for

router = APIRouter(prefix="/task-dependencies", tags=["task-dependencies"])


def _changed(db, user, task_id, before, after):
    task = db.query(Task).filter_by(id=task_id).populate_existing().with_for_update().first()
    if task:
        invalidate_acceptance(db, task, user)
        task.revision += 1
        record_activity(
            db,
            task,
            user,
            "change",
            "维护前置依赖",
            {"dependency": {"before": before, "after": after}},
        )


@router.get("", response_model=list[TaskDependencyOut])
def list_deps(
    project_id: str | None = None,
    task_id: str | None = Query(None, description="返回与此 task 相关（前驱或后继）的依赖"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    visible = visible_task_ids_for(user, db)
    q = db.query(TaskDependency)
    q = q.filter(
        (TaskDependency.predecessor_id.in_(visible)) & (TaskDependency.successor_id.in_(visible))
    )

    if project_id:
        sub_ids = [s.id for s in db.query(SubProject).filter_by(project_id=project_id).all()]
        task_ids = [t.id for t in db.query(Task).filter(Task.sub_project_id.in_(sub_ids)).all()]
        q = q.filter(
            (TaskDependency.predecessor_id.in_(task_ids))
            | (TaskDependency.successor_id.in_(task_ids))
        )
    if task_id:
        q = q.filter(
            (TaskDependency.predecessor_id == task_id) | (TaskDependency.successor_id == task_id)
        )

    return [TaskDependencyOut.model_validate(d) for d in q.all()]


@router.post("", response_model=TaskDependencyOut, status_code=status.HTTP_201_CREATED)
def create_dep(
    payload: TaskDependencyCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    lock_dependency_graph(db)
    if payload.predecessor_id == payload.successor_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "predecessor cannot equal successor")

    pred = db.query(Task).filter_by(id=payload.predecessor_id).first()
    succ = db.query(Task).filter_by(id=payload.successor_id).first()
    if not pred or not succ:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "predecessor / successor not found")

    # 校验都在可见项目内
    visible = visible_project_ids_for(user, db)
    pred_sub = db.query(SubProject).filter_by(id=pred.sub_project_id).first()
    succ_sub = db.query(SubProject).filter_by(id=succ.sub_project_id).first()
    if not pred_sub or pred_sub.project_id not in visible:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "predecessor not visible")
    if not succ_sub or succ_sub.project_id not in visible:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "successor not visible")

    # Share the same project lock as structure editing, calendar changes and reviewed scheduling.
    db.query(Project).filter(
        Project.id.in_(sorted({pred_sub.project_id, succ_sub.project_id}))
    ).order_by(Project.id).with_for_update().all()
    if not {pred_sub.project_id, succ_sub.project_id} <= visible_project_ids_for(user, db):
        raise HTTPException(403, "项目权限已变化，请刷新后重新维护依赖")
    if db.query(Task).filter(Task.id.in_([pred.id, succ.id])).count() != 2:
        raise HTTPException(status.HTTP_409_CONFLICT, "任务已变化，请刷新后重新维护依赖")

    duplicate = (
        db.query(TaskDependency).filter_by(predecessor_id=pred.id, successor_id=succ.id).first()
    )
    if duplicate and duplicate.type == payload.type and duplicate.lag_days == payload.lag_days:
        if payload.id and payload.id != duplicate.id:
            raise HTTPException(409, "依赖已存在，请使用现有记录")
        return TaskDependencyOut.model_validate(duplicate)
    validate_dependency_changes(db, [(pred.id, succ.id, payload.type, payload.lag_days)])
    if payload.id and db.get(TaskDependency, payload.id):
        raise HTTPException(409, "依赖编号已存在")
    if not payload.id:
        payload.id = f"dep-{uuid4().hex[:10]}"

    obj = TaskDependency(**payload.model_dump())
    db.add(obj)
    _changed(db, user, obj.successor_id, None, payload.model_dump())
    db.commit()
    db.refresh(obj)
    return TaskDependencyOut.model_validate(obj)


@router.delete("/{dep_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dep(
    dep_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    lock_dependency_graph(db)
    obj = db.query(TaskDependency).filter_by(id=dep_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "dependency not found")
    projects = {
        row.project_id
        for row in db.query(SubProject)
        .join(Task, Task.sub_project_id == SubProject.id)
        .filter(Task.id.in_([obj.predecessor_id, obj.successor_id]))
    }
    if not projects <= visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "dependency not visible")
    db.query(Project).filter(Project.id.in_(sorted(projects))).order_by(
        Project.id
    ).with_for_update().all()
    if not projects <= visible_project_ids_for(user, db):
        raise HTTPException(403, "项目权限已变化，请刷新后重新维护依赖")
    before = TaskDependencyOut.model_validate(obj).model_dump()
    db.delete(obj)
    _changed(db, user, obj.successor_id, before, None)
    db.commit()
