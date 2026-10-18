"""Users API —— 组织成员目录（只读）。

路由：
    GET    /api/v1/users                列表（按 role / specialty / active / keyword 过滤）
    POST / PATCH / DELETE               已停用（410）：成员由门户「账号管理」统一维护，与 IAM 同步
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User
from app.schemas.user import UserOut
from app.services import members

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
    # 名单以 IAM 为准：在 IAM 管理台停用 / 改名的账号，加载名单时同步（每分钟最多一次）
    members.reconcile_with_iam(db)
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


RETIRED = "成员由门户「账号管理」统一维护（与 IAM 同步），请在账号管理中新建或修改"


# 新增 / 修改 / 删除成员已移到门户「账号管理」：只保留一处能改组织信息，避免项目管理里出现 IAM 没有的成员。
@router.post("", status_code=status.HTTP_410_GONE)
@router.patch("/{user_id}", status_code=status.HTTP_410_GONE)
@router.delete("/{user_id}", status_code=status.HTTP_410_GONE)
def retired_member_writes():
    raise HTTPException(status.HTTP_410_GONE, RETIRED)
