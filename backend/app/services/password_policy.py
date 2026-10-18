"""临时密码须先修改：标记、检查、本人改密与会话失效，门户 / 项目管理 / 账号管理共用。

账号管理新建账号或重置密码后写入标记；本人在门户或项目管理里用临时密码改成新密码后清除。
不用 Casdoor 的「需要更新密码」：3.100.0 打开它后，托管登录页会把人带到 IAM 自己的「我的账户」页、
不再回到应用（刷新也停在那里）。标记期间后端只放行查询身份、改密码和退出（Bearer 访问同样拦截）。
知识库等其他应用直接登录时不受此限制。
"""

import time

from cryptography.fernet import InvalidToken
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import unseal
from app.models import IAMSession, PasswordChangeRequired, PortalSession
from app.services import iam_admin

CHANGE_FIRST = "管理员为你设置了临时密码，请先修改密码后再继续"
# 标记期间仍可调用的接口（其余返回 403）
ALLOWED_PATHS = {
    "/api/v1/auth/me",
    "/api/v1/auth/logout",
    "/api/v1/account/password",
    "/api/v1/portal/me",
    "/api/v1/portal/password",
    "/api/v1/portal/logout",
}


def require_change(db: Session, subject: str, reason: str) -> None:
    db.merge(
        PasswordChangeRequired(
            issuer=settings.casdoor_issuer,
            subject=subject,
            reason=reason,
            required_at=int(time.time()),
        )
    )


def change_required(db: Session, subject: str | None) -> bool:
    return (
        bool(subject)
        and db.get(PasswordChangeRequired, (settings.casdoor_issuer, subject)) is not None
    )


def flagged_subjects(db: Session) -> set[str]:
    rows = db.query(PasswordChangeRequired.subject).filter_by(issuer=settings.casdoor_issuer)
    return {subject for (subject,) in rows}


def clear_change(db: Session, subject: str) -> None:
    db.query(PasswordChangeRequired).filter_by(
        issuer=settings.casdoor_issuer, subject=subject
    ).delete()


def enforce(db: Session, subject: str, path: str) -> None:
    """标记期间除改密码、查询身份、退出外一律 403。"""
    if path not in ALLOWED_PATHS and change_required(db, subject):
        raise HTTPException(status.HTTP_403_FORBIDDEN, CHANGE_FIRST)


def _session_subject(tokens: str) -> str | None:
    try:
        return jwt.get_unverified_claims(unseal(tokens)["access_token"]).get("sub")
    except (InvalidToken, JWTError, ValueError, KeyError, TypeError, AttributeError):
        return None


def end_sessions(db: Session, subject: str, keep: set[str] = frozenset()) -> int:
    """删除该账号在本系统（项目管理与门户）的登录会话，keep 为要保留的会话 id（cookie 的摘要）。"""
    removed = 0
    for model in (IAMSession, PortalSession):
        query = db.query(model)
        if keep:
            query = query.filter(model.id.notin_(keep))
        for session in query:
            if _session_subject(session.tokens) == subject:
                db.delete(session)
                removed += 1
    return removed


def change_own_password(
    db: Session, subject: str, current: str, new: str, keep: set[str] = frozenset()
) -> None:
    """本人改密：Casdoor 校验当前密码与组织密码规则；成功后清除标记，其他设备上的会话退出。

    必须带当前密码：应用凭据调用 set-password 时若旧密码为空，Casdoor 不做校验（管理员重置正是如此）。
    """
    account = iam_admin.get_user_by_sub(subject)
    iam_admin.set_password(account["name"], current, new)
    clear_change(db, subject)
    end_sessions(db, subject, keep)
    db.commit()
