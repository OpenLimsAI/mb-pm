"""Projects API — CRUD 模板 + 团队成员管理 + 行级权限过滤。

路由：
    GET    /api/v1/projects                  分页列表（自动按当前用户 scope 过滤）
    POST   /api/v1/projects                  创建（admin / cmc_lead）
    GET    /api/v1/projects/{id}             详情
    PATCH  /api/v1/projects/{id}             部分更新（owner 或 admin / cmc_lead）
    DELETE /api/v1/projects/{id}             删除（admin / cmc_lead）
    PUT    /api/v1/projects/{id}/members     全量替换团队成员
"""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import (
    Project,
    ProjectFinance,
    ProjectMember,
    SubProject,
    Task,
    TaskDependency,
    User,
)
from app.schemas.common import Page, PageMeta
from app.schemas.project import (
    ProjectCreate,
    ProjectImportRequest,
    ProjectOut,
    ProjectUpdate,
)
from app.services.scope import visible_project_ids_for

router = APIRouter(prefix="/projects", tags=["projects"])


def _scoped_filter(stmt, user: User, db: Session):
    """按 services/scope.py 集中的可见范围收窄查询。"""
    if user.role in ("admin", "cmc_lead"):
        return stmt
    visible = visible_project_ids_for(user, db)
    return stmt.where(Project.id.in_(visible))


@router.get("", response_model=Page[ProjectOut])
def list_projects(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=2000),
    status_filter: str | None = Query(None, alias="status"),
    health: str | None = None,
    keyword: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Project).options(selectinload(Project.members))
    stmt = _scoped_filter(stmt, user, db)

    if status_filter:
        stmt = stmt.where(Project.status == status_filter)
    if health:
        stmt = stmt.where(Project.health == health)
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(or_(Project.name.ilike(like), Project.code.ilike(like)))

    # 简单 count（生产可改子查询优化）
    total = db.execute(stmt).unique().scalars().all()
    total_count = len(total)

    items = total[(page - 1) * page_size : page * page_size]

    return Page[ProjectOut](
        items=[ProjectOut.from_orm_with_members(p) for p in items],
        meta=PageMeta(page=page, page_size=page_size, total=total_count),
    )


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    if not payload.id:
        payload.id = f"p-{uuid4().hex[:12]}"

    if db.query(Project).filter_by(code=payload.code).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"project code {payload.code!r} exists")

    member_ids = payload.member_ids
    data = payload.model_dump(exclude={"member_ids"})
    project = Project(**data)
    db.add(project)
    db.flush()

    for mid in member_ids:
        if mid == project.owner_id:
            continue  # 跳过把 owner 又加成 member
        db.add(ProjectMember(project_id=project.id, user_id=mid))

    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_with_members(project)


@router.post("/import", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def import_project(
    payload: ProjectImportRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    """整包创建：项目 + 子项目 + 任务 + 依赖（前端基于模板实例化后一次性写入）。"""
    p = payload.project
    if not p.id:
        p.id = f"p-{uuid4().hex[:12]}"
    if db.query(Project).filter_by(code=p.code).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"project code {p.code!r} exists")
    if db.get(Project, p.id):
        raise HTTPException(status.HTTP_409_CONFLICT, f"project id {p.id!r} exists")

    member_ids = p.member_ids
    project = Project(**p.model_dump(exclude={"member_ids"}))
    db.add(project)
    db.flush()
    for mid in member_ids:
        if mid != project.owner_id:
            db.add(ProjectMember(project_id=project.id, user_id=mid))

    for s in payload.sub_projects:
        if not s.id:
            s.id = f"sp-{uuid4().hex[:10]}"
        db.add(SubProject(**s.model_dump()))
    db.flush()
    for t in payload.tasks:
        if not t.id:
            t.id = f"tk-{uuid4().hex[:10]}"
        db.add(Task(**t.model_dump()))
    db.flush()
    for d in payload.dependencies:
        if not d.id:
            d.id = f"dep-{uuid4().hex[:10]}"
        db.add(TaskDependency(**d.model_dump()))

    if payload.finance is not None:
        fin = payload.finance.model_dump()
        fin["project_id"] = project.id  # 以新项目 id 为准
        db.add(ProjectFinance(**fin))

    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_with_members(project)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = (
        db.query(Project).options(selectinload(Project.members)).filter_by(id=project_id).first()
    )
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")

    # 行级权限校验
    if user.role not in ("admin", "cmc_lead"):
        is_owner = project.owner_id == user.id
        is_member = any(m.user_id == user.id for m in project.members)
        if not (is_owner or is_member):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "no access to this project")

    return ProjectOut.from_orm_with_members(project)


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = db.query(Project).filter_by(id=project_id).first()
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")

    # 权限：admin/cmc_lead 或 owner
    if user.role not in ("admin", "cmc_lead") and project.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only owner / admin / cmc_lead can edit")

    update_dict = payload.model_dump(exclude_unset=True, exclude={"member_ids"})
    for k, v in update_dict.items():
        setattr(project, k, v)

    if payload.member_ids is not None:
        # 全量替换团队
        db.query(ProjectMember).filter_by(project_id=project.id).delete()
        for mid in payload.member_ids:
            if mid == project.owner_id:
                continue
            db.add(ProjectMember(project_id=project.id, user_id=mid))

    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_with_members(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    project = db.query(Project).filter_by(id=project_id).first()
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    db.delete(project)
    db.commit()


@router.put("/{project_id}/members", response_model=ProjectOut)
def replace_members(
    project_id: str,
    member_ids: list[str],
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """全量替换项目团队成员。"""
    project = db.query(Project).filter_by(id=project_id).first()
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if user.role not in ("admin", "cmc_lead") and project.owner_id != user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "only owner / admin / cmc_lead can edit team"
        )

    db.query(ProjectMember).filter_by(project_id=project.id).delete()
    for mid in set(member_ids):
        if mid == project.owner_id:
            continue
        db.add(ProjectMember(project_id=project.id, user_id=mid))
    db.commit()
    db.refresh(project)
    return ProjectOut.from_orm_with_members(project)
