"""Projects API — CRUD 模板 + 团队成员管理 + 行级权限过滤。

路由：
    GET    /api/v1/projects                  分页列表（自动按当前用户 scope 过滤）
    POST   /api/v1/projects                  创建（admin / cmc_lead）
    GET    /api/v1/projects/{id}             详情
    PATCH  /api/v1/projects/{id}             部分更新（owner 或 admin / cmc_lead）
    DELETE /api/v1/projects/{id}             删除（admin / cmc_lead，含子项目/任务/依赖/团队/财务/基线）
    POST   /api/v1/projects/{id}/copy        复制为新项目（admin / cmc_lead；结构与计划照搬，执行数据重置）
    PUT    /api/v1/projects/{id}/members     全量替换团队成员（仍有任务的人不能移出，见 services/team.py）
"""

from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_role
from app.api.v1.mdm_integration import reference_user
from app.db.session import get_db
from app.models import (
    Project,
    ProjectAIAnalysis,
    ProjectBaseline,
    ProjectFinance,
    ProjectMember,
    SubProject,
    Task,
    TaskDependency,
    User,
)
from app.schemas.business_values import validate_date_patch
from app.schemas.common import Page, PageMeta
from app.schemas.project import (
    ProjectCopyIn,
    ProjectCreate,
    ProjectImportRequest,
    ProjectOut,
    ProjectUpdate,
)
from app.services.mdm_links import mdm_url
from app.services.project_copy import copy_project
from app.services.rollup import live_health, live_span
from app.services.scope import visible_project_ids_for
from app.services.team import ensure_assignees_kept, include_assignees

router = APIRouter(prefix="/projects", tags=["projects"])


def _out(projects: list[Project], db: Session) -> list[ProjectOut]:
    """构造响应；health 按当天实时派生，计划起止按任务实时派生（services/rollup），不依赖已存值。"""
    health = live_health(db, projects)
    span = live_span(db, projects)
    return [
        ProjectOut.from_orm_with_members(p).model_copy(
            update={
                "health": health[p.id],
                "planned_start": span[p.id][0],
                "planned_end": span[p.id][1],
            }
        )
        for p in projects
    ]


def _scoped_filter(stmt, user: User, db: Session):
    """按 services/scope.py 集中的可见范围收窄查询。"""
    if user.role in ("admin", "cmc_lead"):
        return stmt
    visible = visible_project_ids_for(user, db)
    return stmt.where(Project.id.in_(visible))


def _reference_project(project_id: str, user: User, db: Session) -> Project:
    project = db.scalar(_scoped_filter(select(Project).where(Project.id == project_id), user, db))
    if project is None:
        raise HTTPException(404, "项目不存在或无权访问")
    return project


@router.get("/{project_id}/integration-reference")
def integration_reference(
    project_id: str,
    user: Annotated[User, Depends(reference_user)],
    db: Annotated[Session, Depends(get_db)],
):
    project = _reference_project(project_id, user, db)
    return {
        "id": project.id,
        "code": project.code,
        "name": project.name,
        "status": project.status,
        "bindable": project.status in {"活跃", "暂停"},
    }


@router.get("/{project_id}/mdm-launch")
def project_mdm_launch(
    project_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    project = _reference_project(project_id, user, db)
    return {"url": mdm_url(project.id)}


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
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(or_(Project.name.ilike(like), Project.code.ilike(like)))

    # health 按当天实时派生，故在派生后再按 health 过滤（简单 count，生产可改子查询优化）
    outs = _out(db.execute(stmt).unique().scalars().all(), db)
    if health:
        outs = [o for o in outs if o.health == health]

    return Page[ProjectOut](
        items=outs[(page - 1) * page_size : page * page_size],
        meta=PageMeta(page=page, page_size=page_size, total=len(outs)),
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
    return _out([project], db)[0]


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
    order: dict[str, int] = {}  # 子项目内顺序：未提供时按提交顺序（即模板中的顺序）
    for t in payload.tasks:
        if not t.id:
            t.id = f"tk-{uuid4().hex[:10]}"
        if t.sort_order is None:
            t.sort_order = order.get(t.sub_project_id, 0) + 1
        order[t.sub_project_id] = max(order.get(t.sub_project_id, 0), t.sort_order)
        db.add(Task(**t.model_dump()))
    db.flush()
    for d in payload.dependencies:
        if not d.id:
            d.id = f"dep-{uuid4().hex[:10]}"
        db.add(TaskDependency(**d.model_dump()))

    if payload.finance is not None:
        # 已花费由任务实际花费实时汇总，不采用请求中的值
        fin = payload.finance.model_dump(exclude={"spent"})
        fin["project_id"] = project.id  # 以新项目 id 为准
        db.add(ProjectFinance(**fin))
    # 任务负责人 / 协作人自动在团队中
    include_assignees(db, project)

    db.commit()
    db.refresh(project)
    return _out([project], db)[0]


@router.post("/{project_id}/copy", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def copy_project_endpoint(
    project_id: str,
    payload: ProjectCopyIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    """以已有项目为蓝本新建项目（规则见 services/project_copy.py）。权限与新建项目一致。"""
    source = (
        db.query(Project).options(selectinload(Project.members)).filter_by(id=project_id).first()
    )
    if not source:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "要复制的项目不存在")
    project = copy_project(db, source, payload, user)
    return _out([project], db)[0]


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

    # 行级权限校验：与列表同一套可见范围（services/scope.py）
    if user.role not in ("admin", "cmc_lead") and project.id not in visible_project_ids_for(
        user, db
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no access to this project")

    return _out([project], db)[0]


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = db.query(Project).filter_by(id=project_id).with_for_update().first()
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")

    # 权限：admin/cmc_lead 或 owner
    if user.role not in ("admin", "cmc_lead") and project.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only owner / admin / cmc_lead can edit")

    update_dict = payload.model_dump(exclude_unset=True, exclude={"member_ids"})
    if project.progress_method != "equal" and "progress" in update_dict:
        raise HTTPException(422, "项目进度按任务加权汇总，请修改任务进度或进度计算规则")
    validate_date_patch(project, update_dict)
    for k, v in update_dict.items():
        setattr(project, k, v)

    if payload.member_ids is not None:
        # 全量替换团队；仍有任务的人不能移出
        ensure_assignees_kept(db, project, payload.member_ids)
        db.query(ProjectMember).filter_by(project_id=project.id).delete()
        for mid in set(payload.member_ids):
            if mid == project.owner_id:
                continue
            db.add(ProjectMember(project_id=project.id, user_id=mid))
    # 更换负责人后，原负责人若仍有任务则留在团队中
    include_assignees(db, project)

    db.commit()
    db.refresh(project)
    return _out([project], db)[0]


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    """删除项目，连同子项目 / 任务 / 任务依赖 / 团队关联 / 财务 / 基线 / AI 分析；不删除用户账号。"""
    from app.models.mdm_integration import MDMProjectReceipt

    if db.scalar(
        select(MDMProjectReceipt.request_id).where(MDMProjectReceipt.project_id == project_id)
    ):
        raise HTTPException(409, "该项目有MDM来源创建回执，须先协调解除与数据保留，不能直接删除")
    project = db.query(Project).filter_by(id=project_id).first()
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    try:
        # 财务、基线、AI 分析在 Project 上没有 ORM 关系，且 SQLite 默认不执行外键级联：显式删除，避免孤儿行。
        for model in (ProjectFinance, ProjectBaseline, ProjectAIAnalysis):
            db.query(model).filter_by(project_id=project.id).delete(synchronize_session=False)
        # 团队、子项目 → 任务 → 任务依赖 由 ORM cascade 删除。
        db.delete(project)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "项目仍被其他记录引用，暂时无法删除。"
        ) from None


@router.put("/{project_id}/members", response_model=ProjectOut)
def replace_members(
    project_id: str,
    member_ids: list[str],
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """全量替换项目团队成员。"""
    # Team changes must serialize with task creation and reassignment.
    project = db.query(Project).filter_by(id=project_id).with_for_update().first()
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if user.role not in ("admin", "cmc_lead") and project.owner_id != user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "only owner / admin / cmc_lead can edit team"
        )

    ensure_assignees_kept(db, project, member_ids)
    db.query(ProjectMember).filter_by(project_id=project.id).delete()
    for mid in set(member_ids):
        if mid == project.owner_id:
            continue
        db.add(ProjectMember(project_id=project.id, user_id=mid))
    db.commit()
    db.refresh(project)
    return _out([project], db)[0]
