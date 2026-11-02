"""本人账号：改用户名 / 改密码。经后端调用 Casdoor 完成，IAM 仍是唯一的身份来源。

路由：
    POST /api/v1/account/password   校验当前密码后改密码；所有应用会话退出，需重新登录
    POST /api/v1/account/username   校验当前密码后改 IAM 用户名，并同步业务账号的用户名

操作对象只按当前登录用户已绑定的 IAM sub 定位，不接受任何客户端传来的用户标识。
工作台「设置」经门户会话调用同样的逻辑（/portal/username、/portal/password）。
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.api.deps import get_current_user
from app.api.v1.portal import PORTAL_SESSION_COOKIE
from app.core.config import settings
from app.core.security import SESSION_COOKIE
from app.db.session import get_db
from app.models import IAMIdentity, User
from app.schemas.account import PasswordChange, UsernameChange
from app.schemas.user import UserOut
from app.services import own_account, password_policy
from app.services.iam_admin import IAMError

router = APIRouter(prefix="/account", tags=["account"])


def _subject(user: User, db: Session) -> str:
    identity = (
        db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer, user_id=user.id).first()
    )
    if identity is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "当前账号未绑定 IAM 身份，请重新登录")
    return identity.subject


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChange,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    subject = _subject(user, db)
    try:
        password_policy.change_own_password(
            db, subject, payload.current_password, payload.new_password
        )
    except IAMError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    response = Response(status_code=204, headers={"Cache-Control": "no-store"})
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(PORTAL_SESSION_COOKIE, path="/")
    return response


@router.post("/username", response_model=UserOut)
def change_username(
    payload: UsernameChange,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    role = user.role  # 本请求内来自 IAM 的角色（未写回 users 表）
    own_account.change_own_username(
        db, _subject(user, db), payload.new_username, payload.current_password, user
    )
    db.refresh(user)
    set_committed_value(user, "role", role)
    return UserOut.model_validate(user)
