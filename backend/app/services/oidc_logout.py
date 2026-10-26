"""OIDC Back-Channel Logout 1.0 and explicit provider-wide sign out.

Only verified provider events create markers. Provider access tokens remain in
the server session; no identity or bearer token is placed in a browser URL.
"""

import hashlib
import json
import time
from urllib.parse import parse_qs, urlencode

import httpx
from cryptography.fernet import InvalidToken
from fastapi import HTTPException, Request
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from sqlalchemy import delete, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decode_access_token, digest, signing_key, unseal
from app.models import IAMLogin, IAMSession, PortalLogin, PortalSession
from app.models.mdm_integration import OIDCLogoutReplay, OIDCRevocation

EVENT = "http://schemas.openid.net/event/backchannel-logout"


def _key(issuer, audience, subject, sid):
    return hashlib.sha256(
        json.dumps([issuer, audience, subject, sid], separators=(",", ":")).encode()
    ).hexdigest()


def ensure_not_revoked(db: Session, claims: dict, audience: str):
    if not settings.OIDC_GLOBAL_LOGOUT_ENABLED:
        return
    subject = claims.get("sub", "")
    sid = claims.get("sid", "")
    audiences = {audience}
    if audience == settings.MDM_DELEGATION_CLIENT_ID:
        audiences.update({settings.CASDOOR_CLIENT_ID, settings.portal_client_id})
    markers = db.scalars(
        select(OIDCRevocation).where(
            OIDCRevocation.issuer == settings.casdoor_issuer,
            OIDCRevocation.audience.in_(audiences),
            or_(OIDCRevocation.subject == subject, OIDCRevocation.subject == ""),
            or_(OIDCRevocation.sid == "", OIDCRevocation.sid == sid),
        )
    ).all()
    for marker in markers:
        issued = claims.get("iat")
        if (
            not isinstance(issued, int)
            or isinstance(issued, bool)
            or issued <= marker.revoked_before
        ):
            raise HTTPException(401, "统一身份会话已撤销，请重新登录")


def decode_logout_token(token: str) -> tuple[dict, str]:
    if not token or len(token) > 32768:
        raise HTTPException(400, "无效的统一退出通知")
    allowed = {settings.CASDOOR_CLIENT_ID, settings.portal_client_id} - {""}
    try:
        header = jwt.get_unverified_header(token)
        unverified = jwt.get_unverified_claims(token)
        audiences = unverified.get("aud")
        if isinstance(audiences, str):
            audiences = [audiences]
        if not isinstance(audiences, list) or len(audiences) != 1 or audiences[0] not in allowed:
            raise JWTError("audience")
        audience = audiences[0]
        if (
            header.get("alg") != "RS256"
            or not isinstance(header.get("kid"), str)
            or not header["kid"]
        ):
            raise JWTError("algorithm")
        claims = jwt.decode(
            token,
            signing_key(
                header["kid"],
                jwks_url=settings.PORTAL_JWKS_URL or None
                if audience == settings.portal_client_id
                else None,
            ),
            algorithms=["RS256"],
            audience=audience,
            issuer=settings.casdoor_issuer,
            options={
                "require_exp": False,
                "require_aud": True,
                "require_iss": True,
                "verify_at_hash": False,
                "leeway": 10,
            },
        )
        now = int(time.time())
        issued = claims.get("iat")
        if (
            not isinstance(issued, int)
            or isinstance(issued, bool)
            or not now - 300 <= issued <= now + 10
        ):
            raise JWTError("time")
        if not isinstance(claims.get("jti"), str) or not 0 < len(claims["jti"]) <= 255:
            raise JWTError("jti")
        if claims.get("events") != {EVENT: {}} or "nonce" in claims:
            raise JWTError("event")
        subject, sid = claims.get("sub", ""), claims.get("sid", "")
        if (
            not isinstance(subject, str)
            or not isinstance(sid, str)
            or max(len(subject), len(sid)) > 255
            or not (subject or sid)
        ):
            raise JWTError("identity")
        return claims, audience
    except (JWTError, ValueError, TypeError, KeyError):
        raise HTTPException(401, "统一退出通知校验失败") from None


def apply_revocation(db: Session, claims: dict, audience: str):
    issuer = claims["iss"]
    subject = claims.get("sub", "")
    sid = "" if subject else claims.get("sid", "")
    # Deliberate conservative policy: a signed sub event ends all this app's
    # sessions for that subject, even if Casdoor supplies a mismatching Beego sid.
    marker_id = _key(issuer, audience, subject, sid)
    if db.bind.dialect.name == "postgresql":
        key = int.from_bytes(bytes.fromhex(marker_id)[:8], signed=True)
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
    row = db.get(OIDCRevocation, marker_id)
    if row is None:
        db.add(
            OIDCRevocation(
                id=marker_id,
                issuer=issuer,
                audience=audience,
                subject=subject,
                sid=sid,
                revoked_before=claims["iat"],
            )
        )
    else:
        row.revoked_before = max(row.revoked_before, claims["iat"])


def receive_logout(db: Session, token: str) -> None:
    claims, audience = decode_logout_token(token)
    replay_id = _key(claims["iss"], audience, claims["jti"], "")
    payload_hash = hashlib.sha256(
        json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if db.bind.dialect.name == "postgresql":
        key = int.from_bytes(bytes.fromhex(replay_id)[:8], signed=True)
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
    existing = db.get(OIDCLogoutReplay, replay_id)
    if existing:
        if existing.payload_hash != payload_hash:
            raise HTTPException(400, "退出通知标识冲突")
        return
    try:
        apply_revocation(db, claims, audience)
        db.add(
            OIDCLogoutReplay(
                id=replay_id, payload_hash=payload_hash, expires_at=int(time.time()) + 600
            )
        )
        db.execute(delete(OIDCLogoutReplay).where(OIDCLogoutReplay.expires_at < int(time.time())))
        db.commit()
    except IntegrityError:
        db.rollback()
        prior = db.get(OIDCLogoutReplay, replay_id)
        if prior and prior.payload_hash == payload_hash:
            return
        raise HTTPException(409, "退出通知并发冲突，请重试") from None


async def read_logout_form(request: Request) -> str:
    if not settings.OIDC_GLOBAL_LOGOUT_ENABLED:
        raise HTTPException(503, "统一退出回调尚未启用")
    if not request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
        raise HTTPException(400, "需要标准退出通知表单")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 40000:
            raise HTTPException(413, "退出通知过大")
        body.extend(chunk)
    try:
        values = parse_qs(body.decode("utf-8"), max_num_fields=8)
        tokens = values.get("logout_token", [])
        if len(tokens) != 1:
            raise ValueError("token")
        return tokens[0]
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(400, "退出通知格式错误") from None


def _logout_token_state(client, access: str, audience: str, subject: str, *, portal: bool):
    """No cached status: a successful global action must change this exact token."""
    client_id = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
    secret = settings.portal_client_secret if portal else settings.CASDOOR_CLIENT_SECRET
    if not client_id or not secret:
        raise ValueError("logout verification client unavailable")
    response = client.post(
        settings.casdoor_internal_url + "/api/login/oauth/introspect",
        auth=httpx.BasicAuth(client_id, secret),
        data={"token": access, "token_type_hint": "access_token"},
    )
    if response.status_code != 200:
        raise ValueError("logout status unavailable")
    body = response.json()
    if not isinstance(body, dict) or not isinstance(body.get("active"), bool):
        raise ValueError("logout status format")
    if body["active"] is False:
        return False
    if body.get("client_id") != audience or body.get("sub") != subject:
        raise ValueError("logout status identity mismatch")
    return True


def global_logout(request: Request, db: Session, *, portal: bool = False):
    from app.api.v1.portal import PORTAL_LOGIN_COOKIE, PORTAL_SESSION_COOKIE
    from app.core.security import LOGIN_COOKIE, SESSION_COOKIE

    cookie = PORTAL_SESSION_COOKIE if portal else SESSION_COOKIE
    model = PortalSession if portal else IAMSession
    identifier = request.cookies.get(cookie, "")
    session = db.get(model, digest(identifier)) if identifier else None
    succeeded = False
    claims = None
    if session:
        try:
            access = unseal(session.tokens)["access_token"]
            audience = settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID
            claims = decode_access_token(
                access,
                audience=audience,
                jwks_url=settings.PORTAL_JWKS_URL or None if portal else None,
            )
            with httpx.Client(timeout=8, trust_env=False, follow_redirects=False) as client:
                if not _logout_token_state(client, access, audience, claims["sub"], portal=portal):
                    raise ValueError("global logout requires an active own-user token")
                result = client.post(
                    settings.casdoor_internal_url + "/api/sso-logout",
                    params={"logoutAll": "true"},
                    headers={"Authorization": "Bearer " + access},
                )
                payload = result.json()
                acknowledged = (
                    result.status_code == 200
                    and isinstance(payload, dict)
                    and payload.get("status") == "ok"
                )
                if acknowledged:
                    succeeded = not _logout_token_state(
                        client, access, audience, claims["sub"], portal=portal
                    )
        except (InvalidToken, httpx.HTTPError, HTTPException, ValueError, TypeError, KeyError):
            succeeded = False
    if claims:
        # Revoke own PM/portal sessions even if provider notification is delayed.
        for audience in sorted({settings.CASDOOR_CLIENT_ID, settings.portal_client_id}):
            apply_revocation(
                db, {"iss": claims["iss"], "sub": claims["sub"], "iat": int(time.time())}, audience
            )
    for model, cookie_name in [
        (IAMSession, SESSION_COOKIE),
        (IAMLogin, LOGIN_COOKIE),
        (PortalSession, PORTAL_SESSION_COOKIE),
        (PortalLogin, PORTAL_LOGIN_COOKIE),
    ]:
        identifier = request.cookies.get(cookie_name, "")
        if identifier:
            db.execute(delete(model).where(model.id == digest(identifier)))
    db.commit()
    origin = settings.portal_origin if portal else settings.pms_origin
    if succeeded:
        params = {
            "client_id": settings.portal_client_id if portal else settings.CASDOOR_CLIENT_ID,
            "post_logout_redirect_uri": origin + "/login",
        }
        destination = settings.casdoor_issuer + "/api/logout?" + urlencode(params)
    else:
        destination = origin + "/login?error=logout_incomplete"
    response = RedirectResponse(destination, 303)
    for cookie_name in [SESSION_COOKIE, LOGIN_COOKIE, PORTAL_SESSION_COOKIE, PORTAL_LOGIN_COOKIE]:
        response.delete_cookie(cookie_name, path="/")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def local_logout(request: Request, db: Session, *, portal: bool = False):
    from app.api.v1.portal import PORTAL_LOGIN_COOKIE, PORTAL_SESSION_COOKIE
    from app.core.security import LOGIN_COOKIE, SESSION_COOKIE

    pairs = (
        [(PortalSession, PORTAL_SESSION_COOKIE), (PortalLogin, PORTAL_LOGIN_COOKIE)]
        if portal
        else [(IAMSession, SESSION_COOKIE), (IAMLogin, LOGIN_COOKIE)]
    )
    for model, cookie in pairs:
        identifier = request.cookies.get(cookie, "")
        if identifier:
            db.execute(delete(model).where(model.id == digest(identifier)))
    db.commit()
    origin = settings.portal_origin if portal else settings.pms_origin
    response = RedirectResponse(
        origin + "/login?local=1&app=" + ("portal" if portal else "pm"), 303
    )
    for _, cookie in pairs:
        response.delete_cookie(cookie, path="/")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response
