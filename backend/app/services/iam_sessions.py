"""Server-only session renewal with a database lock shared by all app instances.

Only the original signed identity can renew. Old sessions without a refresh token
retain their original deadline and must sign in once to adopt renewal.
"""

import time

import httpx
from cryptography.fernet import InvalidToken
from fastapi import HTTPException, Request
from jose.exceptions import ExpiredSignatureError
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.auth_logging import auth_failure
from app.core.config import settings
from app.core.security import decode_access_token, digest, seal, unseal
from app.models import IAMSession, PortalSession
from app.services import oidc_logout, oidc_status, password_policy


def _refresh_token(value) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 32768
        or any(c.isspace() for c in value)
    ):
        raise ValueError("invalid refresh token response")
    return value


def create_session_payload(tokens: dict, claims: dict, identity: dict) -> tuple[str, int]:
    now = int(time.time())
    access, identifier = tokens["access_token"], tokens["id_token"]
    expiry = min(int(claims["exp"]), int(identity["exp"]), now + settings.IAM_SESSION_SECONDS)
    data = {"access_token": access, "id_token": identifier}
    if settings.OIDC_DEVICE_LOGOUT_ENABLED and identity.get("sid"):
        sid = identity["sid"]
        if not isinstance(sid, str) or len(sid) > 255 or claims.get("sid") not in (None, "", sid):
            raise ValueError("inconsistent verified session identity")
        data["authenticated_sid"] = sid
    refresh = _refresh_token(tokens.get("refresh_token"))
    if refresh:
        data.update(
            refresh_token=refresh,
            started_at=now,
            last_seen_at=now,
            authenticated_iat=claims.get("iat", now),
            authenticated_sid=data.get("authenticated_sid", claims.get("sid", "")),
        )
        expiry = now + settings.IAM_SESSION_ABSOLUTE_SECONDS
    return seal(data), expiry


def _decode(token, *, portal: bool, allow_expired: bool = False):
    return decode_access_token(
        token,
        audience=settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID,
        jwks_url=settings.PORTAL_JWKS_URL or None if portal else None,
        allow_expired=allow_expired,
    )


def verified_session_sid(data: dict, claims: dict, *, portal: bool = False) -> str:
    """Only encrypted login metadata or a re-verified stored ID token; no URL input."""
    sid = data.get("authenticated_sid") or claims.get("sid")
    if not sid and data.get("id_token"):
        audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
        identity = decode_access_token(
            data["id_token"],
            audience=audience,
            jwks_url=settings.PORTAL_JWKS_URL or None if portal else None,
            allow_expired=True,
            access_token=data["access_token"],
        )
        if identity.get("sub") != claims.get("sub") or identity.get("iss") != claims.get("iss"):
            raise ValueError("stored identity mismatch")
        sid = identity.get("sid")
    if sid is None or sid == "":
        return ""
    if not isinstance(sid, str) or len(sid) > 255:
        raise ValueError("invalid verified session id")
    return sid


def _bound_identity(claims, audience, request, *, previous=None):
    if claims.get("owner") != settings.CASDOOR_ORG:
        raise auth_failure(request, "identity_mismatch", "统一身份组织不匹配", 403)
    if claims.get("isForbidden") or claims.get("isDeleted"):
        raise auth_failure(request, "account_disabled", "统一身份账号已停用或删除", 403)
    audiences = claims.get("aud")
    if (
        audiences not in (audience, [audience])
        or claims.get("azp", audience) != audience
        or not isinstance(claims.get("sub"), str)
        or not 0 < len(claims["sub"]) <= 255
        or previous is not None
        and claims["sub"] != previous["sub"]
    ):
        raise auth_failure(request, "identity_mismatch", "统一身份主体或应用不匹配")


def _checked_decode(token, request, *, portal, allow_expired=False):
    if not isinstance(token, str):
        raise auth_failure(request, "token_invalid", "登录会话令牌无效，请重新登录")
    try:
        return _decode(token, portal=portal, allow_expired=allow_expired)
    except HTTPException as exc:
        raise auth_failure(
            request,
            (
                "token_expired"
                if isinstance(exc.__cause__, ExpiredSignatureError)
                else "token_invalid"
            )
            if exc.status_code == 401
            else "provider_unavailable",
            exc.detail,
            exc.status_code,
        ) from None


def _checked_status(token, claims, request, *, db, audience, portal, authenticated_iat=None):
    try:
        oidc_logout.ensure_not_revoked(db, claims, audience)
    except HTTPException as exc:
        raise auth_failure(request, "revoked", exc.detail, exc.status_code) from None
    try:
        oidc_status.ensure_active_token(
            token,
            claims,
            expected_audience=audience,
            portal=portal,
            authenticated_iat=authenticated_iat,
        )
    except HTTPException as exc:
        reason = (
            "provider_unavailable"
            if exc.status_code == 503
            else "account_disabled"
            if exc.status_code == 403
            else "provider_rejected"
        )
        raise auth_failure(request, reason, exc.detail, exc.status_code) from None


def _renew(data, previous, request, *, portal, db, audience):
    try:
        response = httpx.post(
            settings.casdoor_token_url,
            data={
                "grant_type": "refresh_token",
                "client_id": audience,
                "client_secret": settings.portal_client_secret
                if portal
                else settings.CASDOOR_CLIENT_SECRET,
                "refresh_token": data["refresh_token"],
            },
            timeout=10,
            trust_env=False,
            follow_redirects=False,
        )
        payload = response.json()
    except (httpx.HTTPError, ValueError, TypeError):
        raise auth_failure(
            request, "provider_unavailable", "登录续期服务暂不可用，请稍后重试", 503
        ) from None
    if isinstance(payload, dict) and payload.get("error") == "invalid_grant":
        raise auth_failure(request, "refresh_rejected", "登录授权已失效，请重新登录")
    if response.status_code != 200 or not isinstance(payload, dict) or payload.get("error"):
        raise auth_failure(request, "provider_unavailable", "登录续期服务暂不可用，请稍后重试", 503)
    try:
        refresh = _refresh_token(payload.get("refresh_token"))
        if not refresh:
            raise ValueError("missing rotated refresh token")
        access, identifier = payload["access_token"], payload["id_token"]
        if any(not isinstance(t, str) or not 0 < len(t) <= 32768 for t in (access, identifier)):
            raise ValueError("invalid token response")
    except (ValueError, KeyError, TypeError):
        raise auth_failure(
            request, "refresh_invalid_response", "登录续期响应无效，请重新登录", 503
        ) from None
    claims = _checked_decode(access, request, portal=portal)
    identity = _checked_decode(identifier, request, portal=portal)
    _bound_identity(claims, audience, request, previous=previous)
    _bound_identity(identity, audience, request, previous=previous)
    # Casdoor v3.152.0 refresh responses use the new access JWT as id_token:
    # a first-login nonce is not present in this response. Identity is bound above.
    now = int(time.time())
    issued = claims.get("iat")
    if (
        not isinstance(issued, int)
        or isinstance(issued, bool)
        or not now - 300 <= issued <= now + 10
    ):
        raise auth_failure(request, "refresh_invalid_response", "登录续期时间校验失败", 503)
    if min(int(claims["exp"]), int(identity["exp"])) <= now:
        raise auth_failure(request, "refresh_invalid_response", "登录续期令牌已过期", 503)
    _check_chain(db, previous, data, audience, request)
    return {
        **data,
        "access_token": access,
        "id_token": identifier,
        "refresh_token": refresh,
    }, claims


def _check_chain(db, claims, data, audience, request):
    # Revocation applies to the original authorization, not a later refresh's iat.
    # Rechecking after the HTTP response catches backchannel events during refresh.
    original = {
        **claims,
        "iat": data.get("authenticated_iat", claims.get("iat")),
        "sid": data.get("authenticated_sid", claims.get("sid", "")),
    }
    try:
        oidc_logout.ensure_not_revoked(db, original, audience)
    except HTTPException as exc:
        raise auth_failure(request, "revoked", exc.detail, exc.status_code) from None


def session_claims(request: Request, db: Session, *, portal: bool = False) -> dict:
    model, cookie = (
        (PortalSession, "mbportal_iam_session") if portal else (IAMSession, "mbpm_iam_session")
    )
    identifier = request.cookies.get(cookie, "")
    if not identifier:
        raise auth_failure(
            request, "session_missing", "请先登录迈博工作台" if portal else "请先登录 IAM"
        )
    audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    # A separate short transaction releases the auth lock before any model or
    # business operation and never commits the caller's pending business changes.
    bind = db.get_bind()
    # In-memory SQLite has one physical connection; use a savepoint rather than
    # letting an independent session roll back a caller's unrelated transaction.
    shared_memory = (
        isinstance(getattr(bind, "pool", None), StaticPool) and bind.dialect.name == "sqlite"
    )
    auth_session = (
        Session(
            bind=db.connection(), join_transaction_mode="create_savepoint", expire_on_commit=False
        )
        if shared_memory
        else Session(bind=bind, expire_on_commit=False)
    )
    with auth_session as auth_db:
        row = auth_db.scalar(select(model).where(model.id == digest(identifier)).with_for_update())
        now = int(time.time())
        if row is None:
            raise auth_failure(request, "session_missing", "登录会话不存在，请重新登录")
        if row.expires_at <= now:
            raise auth_failure(request, "session_expired", "登录会话已到期，请重新登录")
        try:
            data = unseal(row.tokens)
            access = data["access_token"]
            refresh = _refresh_token(data.get("refresh_token"))
        except (InvalidToken, ValueError, TypeError, KeyError):
            raise auth_failure(request, "decrypt_failed", "登录会话已失效，请重新登录") from None
        claims = _checked_decode(access, request, portal=portal, allow_expired=bool(refresh))
        _bound_identity(claims, audience, request)
        if settings.OIDC_DEVICE_LOGOUT_ENABLED:
            try:
                claims["sid"] = verified_session_sid(data, claims, portal=portal)
            except (ValueError, HTTPException):
                raise auth_failure(request, "identity_mismatch", "原始登录会话无法核验") from None
        changed = False
        if refresh:
            started, last_seen = data.get("started_at"), data.get("last_seen_at")
            if any(
                not isinstance(t, int) or isinstance(t, bool) or not 0 < t <= now + 10
                for t in (started, last_seen)
            ):
                raise auth_failure(request, "session_invalid", "登录会话元数据无效，请重新登录")
            if now >= started + settings.IAM_SESSION_ABSOLUTE_SECONDS:
                raise auth_failure(request, "session_expired", "本次登录已达到最长时间，请重新登录")
            if now >= last_seen + settings.IAM_SESSION_SECONDS:
                raise auth_failure(request, "session_idle", "登录会话闲置超时，请重新登录")
            if settings.OIDC_GLOBAL_LOGOUT_ENABLED and (
                not isinstance(data.get("authenticated_iat"), int)
                or isinstance(data.get("authenticated_iat"), bool)
                or not 0 < data["authenticated_iat"] <= started + 10
            ):
                # Legacy refresh cookies cannot prove when their authorization
                # began; a newly issued token must not resurrect a pre-reset chain.
                raise auth_failure(
                    request, "session_invalid", "登录会话缺少原始认证时间，请重新登录"
                )
            data.setdefault("authenticated_iat", claims.get("iat"))
            data.setdefault("authenticated_sid", claims.get("sid", ""))
            _check_chain(auth_db, claims, data, audience, request)
            if int(claims["exp"]) <= now + settings.IAM_REFRESH_LEEWAY_SECONDS:
                data, claims = _renew(
                    data, claims, request, portal=portal, db=auth_db, audience=audience
                )
                try:
                    _checked_status(
                        data["access_token"],
                        claims,
                        request,
                        db=auth_db,
                        audience=audience,
                        portal=portal,
                        authenticated_iat=data.get("authenticated_iat"),
                    )
                except HTTPException as exc:
                    if exc.status_code == 503:
                        # The provider has already rotated/deleted the old token.
                        # Preserve the verified replacement for a later status
                        # recheck, but do NOT authorize this failed request or
                        # advance its idle activity timestamp.
                        row.tokens = seal(data)
                        auth_db.commit()
                    raise
                request.state.auth_refreshed = True
                changed = True
            else:
                _checked_status(
                    access,
                    claims,
                    request,
                    db=auth_db,
                    audience=audience,
                    portal=portal,
                    authenticated_iat=data.get("authenticated_iat"),
                )
            if now - last_seen >= 60:
                data["last_seen_at"] = now
                changed = True
        else:
            _checked_status(access, claims, request, db=auth_db, audience=audience, portal=portal)
        if password_policy.observe_identity(auth_db, claims):
            changed = True
        password_policy.enforce(auth_db, claims["sub"], request.url.path)
        if changed:
            row.tokens = seal(data)
            auth_db.commit()
        return claims
