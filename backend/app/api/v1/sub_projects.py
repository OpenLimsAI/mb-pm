"""SubProjects API — Level 2 WBS。

路由：
    GET    /api/v1/sub-projects?project_id=...   按项目过滤（必填）
    POST   /api/v1/sub-projects                  创建（admin/cmc_lead/project_lead）
    GET    /api/v1/sub-projects/{id}
    PATCH  /api/v1/sub-projects/{id}
    DELETE /api/v1/sub-projects/{id}
"""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import SubProject, User
from app.schemas.task import SubProjectCreate, SubProjectOut, SubProjectUpdate
from app.services.scope import visible_project_ids_for

router = APIRouter(prefix="/sub-projects", tags=["sub-projects"])


@router.get("", response_model=list[SubProjectOut])
def list_sub_projects(
    project_id: str | None = Query(None, description="按项目过滤"),
    module: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    visible = visible_project_ids_for(user, db)
    q = db.query(SubProject).filter(SubProject.project_id.in_(visible))
    if project_id:
        if project_id not in visible:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "project not visible")
        q = q.filter(SubProject.project_id == project_id)
    if module:
        q = q.filter(SubProject.module == module)
    q = q.order_by(SubProject.project_id, SubProject.sort_order)
    return [SubProjectOut.model_validate(s) for s in q.all()]


@router.post("", response_model=SubProjectOut, status_code=status.HTTP_201_CREATED)
def create_sub_project(
    payload: SubProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    if not payload.id:
        payload.id = f"sp-{uuid4().hex[:10]}"

    # 校验 project_id 可见
    visible = visible_project_ids_for(user, db)
    if payload.project_id not in visible:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "project not visible to creator")

    obj = SubProject(**payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return SubProjectOut.model_validate(obj)


@router.get("/{sub_id}", response_model=SubProjectOut)
def get_sub_project(
    sub_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    obj = db.query(SubProject).filter_by(id=sub_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sub-project not found")
    if obj.project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no access")
    return SubProjectOut.model_validate(obj)


@router.patch("/{sub_id}", response_model=SubProjectOut)
def update_sub_project(
    sub_id: str,
    payload: SubProjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    obj = db.query(SubProject).filter_by(id=sub_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sub-project not found")
    if obj.project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no access")

    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return SubProjectOut.model_validate(obj)


@router.delete("/{sub_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sub_project(
    sub_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead", "project_lead")),
):
    obj = db.query(SubProject).filter_by(id=sub_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sub-project not found")
    if obj.project_id not in visible_project_ids_for(user, db):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no access")
    db.delete(obj)
    db.commit()
