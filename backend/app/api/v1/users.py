"""Users API —— 组织成员目录 + 增删改（admin / cmc_lead）。

路由：
    GET    /api/v1/users                列表（按 role / specialty / active / keyword 过滤）
    POST   /api/v1/users                新增成员
    PATCH  /api/v1/users/{id}           更新（停用/启用、角色、专业组等）
    DELETE /api/v1/users/{id}           删除（引用守卫：仍负责项目/任务则拒绝，建议先停用）
"""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models import (
    AuditLog,
    FinanceAIAnalysis,
    Project,
    ProjectAIAnalysis,
    SubProject,
    Task,
    User,
)
from app.schemas.user import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserOut])
def list_users(
    role: str | None = None,
    specialty_group: str | None = None,
    is_active: bool | None = None,
    keyword: str | None = Query(None, description="模糊匹配 username / display_name"),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    q = db.query(User)
    if role:
        q = q.filter(User.role == role)
    if specialty_group:
        q = q.filter(User.specialty_group == specialty_group)
    if is_active is not None:
        q = q.filter(User.is_active == is_active)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter((User.username.ilike(like)) | (User.display_name.ilike(like)))
    return [UserOut.model_validate(u) for u in q.order_by(User.display_name).all()]


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_role("admin", "cmc_lead")),
):
    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"用户名 {payload.username!r} 已存在")
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"邮箱 {payload.email!r} 已存在")

    uid = payload.id or f"u-{uuid4().hex[:10]}"
    if db.query(User).filter_by(id=uid).first():
        raise HTTPException(status.HTTP_409_CONFLICT, f"id {uid!r} 已存在")

    data = payload.model_dump(exclude={"id"})
    obj = User(id=uid, **data)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return UserOut.model_validate(obj)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_role("admin", "cmc_lead")),
):
    obj = db.query(User).filter_by(id=user_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")

    data = payload.model_dump(exclude_unset=True)
    if "email" in data and data["email"] != obj.email:
        if db.query(User).filter(User.email == data["email"]).first():
            raise HTTPException(status.HTTP_409_CONFLICT, f"邮箱 {data['email']!r} 已存在")

    for k, v in data.items():
        setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return UserOut.model_validate(obj)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin", "cmc_lead")),
):
    obj = db.query(User).filter_by(id=user_id).first()
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    if obj.id == user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "不能删除当前登录用户")

    # 引用守卫：仍承担工作的成员不可硬删除（避免悬挂负责人），建议先停用或转移
    owns_proj = db.query(Project).filter_by(owner_id=user_id).count()
    owns_task = db.query(Task).filter_by(owner_id=user_id).count()
    owns_sub = db.query(SubProject).filter_by(owner_id=user_id).count()
    has_audit = db.query(AuditLog).filter_by(actor_id=user_id).count()
    has_analysis = (
        db.query(ProjectAIAnalysis).filter_by(created_by=user_id).count()
        + db.query(FinanceAIAnalysis).filter_by(created_by=user_id).count()
    )
    if owns_proj or owns_task or owns_sub or has_audit or has_analysis:
        parts = []
        if owns_proj:
            parts.append(f"{owns_proj} 个项目")
        if owns_task:
            parts.append(f"{owns_task} 个任务")
        if owns_sub:
            parts.append(f"{owns_sub} 个子项目")
        if has_analysis:
            parts.append(f"{has_analysis} 份 AI 分析记录")
        detail = "、".join(parts) if parts else "审计记录"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"该成员仍负责 {detail}，请先停用或将负责人转移给他人后再删除。",
        )

    # ProjectMember 关系级联删除（成员身份），可安全删除用户
    db.delete(obj)
    db.commit()
