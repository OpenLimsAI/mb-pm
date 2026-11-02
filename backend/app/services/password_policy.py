"""Shared temporary-password policy and provider-wide password revocation.

IAM needUpdatePassword is authoritative across applications. Local markers also
protect existing accounts until the live IAM password timestamp proves completion.
Successful changes end every session, including the initiating browser.
"""

import time

from cryptography.fernet import InvalidToken
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import unseal
from app.models import IAMSession, PasswordChangeRequired, PortalSession
from app.services import iam_admin, oidc_logout

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


def observe_identity(db: Session, claims: dict) -> bool:
    """Consume only state attached by the fresh, subject-bound IAM status check."""
    state = claims.get("_iam_password_state")
    if not isinstance(state, dict):
        return False
    marker = db.get(PasswordChangeRequired, (settings.casdoor_issuer, claims["sub"]))
    if state["required"] and marker is None:
        require_change(db, claims["sub"], "iam")
        db.flush()
        return True
    if not state["required"] and marker and state["changed_at"] >= marker.required_at:
        db.delete(marker)
        db.flush()
        return True
    return False


def revoke_local_authorizations(db: Session, subject: str) -> int:
    """Shared database markers cover PM/portal/delegated Bearer tokens on all instances."""
    now = int(time.time())
    for audience in {settings.CASDOOR_CLIENT_ID, settings.portal_client_id} - {""}:
        oidc_logout.apply_revocation(
            db, {"iss": settings.casdoor_issuer, "sub": subject, "iat": now}, audience
        )
    return end_sessions(db, subject)


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
    """Verify the current password, change it, then revoke all app/SSO authorizations.

    `keep` is retained only for API compatibility and deliberately ignored.
    A password change cannot be rolled back on a provider outage. Persist local
    revocation even if the provider cleanup fails, and never report that as success.
    """
    account = iam_admin.get_user_by_sub(subject)
    iam_admin.check_revocation_available(account)
    iam_admin.set_password(account["name"], current, new)
    clear_change(db, subject)
    revoke_local_authorizations(db, subject)
    db.commit()
    try:
        iam_admin.revoke_user_authorizations(subject)
    except (iam_admin.IAMError, HTTPException):
        raise HTTPException(
            503,
            "密码已修改且本系统会话已退出，但统一身份会话撤销未完成，请联系管理员处理，勿重复提交旧密码",
        ) from None
