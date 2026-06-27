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
from app.db.session import get_db
from app.models import SubProject, Task, TaskDependency, User
from app.schemas.task import TaskDependencyCreate, TaskDependencyOut
from app.services.scope import visible_project_ids_for, visible_task_ids_for

router = APIRouter(prefix="/task-dependencies", tags=["task-dependencies"])


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

    if not payload.id:
        payload.id = f"dep-{uuid4().hex[:10]}"

    obj = TaskDependency(**payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return TaskDependencyOut.model_validate(obj)


@router.delete("/{dep_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dep(
    dep_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    obj = db.query(TaskDependency).filter_by(id=dep_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "dependency not found")
    db.delete(obj)
    db.commit()
