"""本人账号：改用户名 / 改密码。经后端调用 Casdoor 完成，IAM 仍是唯一的身份来源。

路由：
    POST /api/v1/account/password   校验当前密码后改密码；本系统在其他设备上的会话一并退出
    POST /api/v1/account/username   校验当前密码后改 IAM 用户名，并同步业务账号的用户名

操作对象只按当前登录用户已绑定的 IAM sub 定位，不接受任何客户端传来的用户标识。
"""

import logging

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError, jwt
from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.security import SESSION_COOKIE, digest, unseal
from app.db.session import get_db
from app.models import IAMIdentity, IAMSession, User
from app.schemas.account import PasswordChange, UsernameChange
from app.schemas.user import UserOut
from app.services import iam_admin
from app.services.iam_admin import IAMError

router = APIRouter(prefix="/account", tags=["account"])
log = logging.getLogger(__name__)


def _subject(user: User, db: Session) -> str:
    identity = (
        db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer, user_id=user.id).first()
    )
    if identity is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "当前账号未绑定 IAM 身份，请重新登录")
    return identity.subject


def _session_subject(session: IAMSession) -> str | None:
    try:
        return jwt.get_unverified_claims(unseal(session.tokens)["access_token"]).get("sub")
    except (InvalidToken, JWTError, ValueError, KeyError, TypeError, AttributeError):
        return None


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChange,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    subject = _subject(user, db)
    account = iam_admin.get_user_by_sub(subject)
    try:
        iam_admin.set_password(account["name"], payload.current_password, payload.new_password)
    except IAMError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    # 密码已改：本系统在其他设备 / 浏览器上的会话一并失效，当前会话保留。
    current = request.cookies.get(SESSION_COOKIE)
    keep = digest(current) if current else None
    for session in db.query(IAMSession).filter(IAMSession.id != keep):
        if _session_subject(session) == subject:
            db.delete(session)
    db.commit()


@router.post("/username", response_model=UserOut)
def change_username(
    payload: UsernameChange,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    new_name = payload.new_username
    subject = _subject(user, db)
    old_name = iam_admin.get_user_by_sub(subject)["name"]
    if new_name == old_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "新用户名与当前用户名相同")
    # 预置但尚未开通 IAM 的业务用户也占用其用户名（首次登录按用户名关联）
    if db.query(User.id).filter(func.lower(User.username) == new_name, User.id != user.id).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "该用户名已被占用")
    if iam_admin.name_shared_across_orgs(old_name):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "IAM 的其他组织中有同名成员，为避免误改其角色，请联系 IAM 管理员修改用户名",
        )
    try:
        iam_admin.verify_password(old_name, payload.current_password)
        iam_admin.rename_user(subject, new_name)
    except IAMError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    role = user.role  # 本请求内来自 IAM 的角色（未写回 users 表）
    user.username = new_name
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        try:
            iam_admin.rename_user(subject, old_name)
            detail = "用户名同步失败，已撤销修改，请稍后重试"
        except Exception:
            log.exception("用户名同步失败且 IAM 改名未能撤销：%s → %s", old_name, new_name)
            detail = f"用户名同步失败：IAM 中已改为 {new_name}，请联系管理员核对"
        raise HTTPException(status.HTTP_409_CONFLICT, detail) from exc
    db.refresh(user)
    set_committed_value(user, "role", role)
    return UserOut.model_validate(user)
