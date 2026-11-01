"""IAM 登录（mb-casd / Casdoor）：授权码 + PKCE S256，由后端换取令牌，令牌不出服务端。

路由：
    GET  /api/v1/auth/login      生成 state / nonce / PKCE，302 到 Casdoor 授权页
    GET  /api/v1/auth/config     前端获取规范登录入口（保证 cookie 与回调同一 origin）、兼容旧前端的关闭注册标记
    POST /api/v1/auth/register   已停用：返回 410，账号由 IAM 平台开通
    GET  /api/v1/auth/callback   校验 state → 换 token → 验签 + nonce → 建立 HttpOnly 会话
    POST /api/v1/auth/logout     销毁业务会话，再跳 Casdoor /api/logout 清 SSO
    GET  /api/v1/auth/me         当前用户（角色取自 IAM）
"""

import base64
import hashlib
import secrets
import time
from typing import Annotated
from urllib.parse import urlencode

import httpx
from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_same_origin
from app.core.config import settings
from app.core.security import (
    LOGIN_COOKIE,
    SESSION_COOKIE,
    decode_access_token,
    digest,
    resolve_identity,
    seal,
    unseal,
)
from app.db.session import get_db
from app.models import IAMIdentity, IAMLogin, IAMSession, User
from app.schemas.auth import LoginStart
from app.schemas.user import MeOut, UserOut
from app.services import iam_login, password_policy

router = APIRouter(prefix="/auth", tags=["auth"])

LOGIN_PAGE = "/login"


def set_cookie(response, name, value, age):
    response.set_cookie(
        name,
        value,
        max_age=age,
        httponly=True,
        secure=settings.IAM_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def safe_return_to(value: str) -> str:
    """只接受站内绝对路径；协议相对（//host）、反斜杠、控制字符一律回落首页，杜绝开放重定向。"""
    if (
        not value.startswith("/")
        or value.startswith("//")
        or "\\" in value
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        return "/"
    return value


def login_error(code: str):
    response = RedirectResponse(
        settings.pms_origin + LOGIN_PAGE + "?" + urlencode({"error": code}), 303
    )
    response.delete_cookie(LOGIN_COOKIE, path="/")
    response.delete_cookie(SESSION_COOKIE, path="/")
    return no_cache(response)


def begin_login(db: Session, return_to: str) -> dict:
    """生成 state / PKCE / nonce 并保存登录事务，返回 IAM 授权参数（跳转登录页与嵌入式登录共用）。"""
    if not settings.CASDOOR_CLIENT_SECRET:
        raise HTTPException(503, "IAM 客户端尚未配置")
    return_to = safe_return_to(return_to)
    state, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    now = int(time.time())
    # 顺带清理过期的登录态与会话。
    db.execute(delete(IAMLogin).where(IAMLogin.expires_at < now))
    db.execute(delete(IAMSession).where(IAMSession.expires_at < now))
    db.add(
        IAMLogin(
            id=digest(state),
            expires_at=now + 600,
            data=seal({"verifier": verifier, "nonce": nonce, "return_to": return_to}),
        )
    )
    db.commit()
    return {
        "client_id": settings.CASDOOR_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": settings.iam_callback_url,
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }


@router.get("/login")
def login(db: Session = Depends(get_db), return_to: str = Query("/", max_length=2048)):
    params = begin_login(db, return_to)
    response = RedirectResponse(
        settings.casdoor_issuer + "/login/oauth/authorize?" + urlencode(params), 303
    )
    set_cookie(response, LOGIN_COOKIE, params["state"], 600)
    return no_cache(response)


@router.post("/login/start")
def login_start(
    request: Request, body: LoginStart, response: Response, db: Session = Depends(get_db)
):
    """嵌入式登录：登录页直接输入用户名 / 密码（见 services/iam_login.py）。"""
    require_same_origin(request, origin=settings.pms_origin)
    params = begin_login(db, body.return_to)
    set_cookie(response, LOGIN_COOKIE, params["state"], 600)
    no_cache(response)
    return iam_login.embedded_login(params)


@router.get("/config")
def config():
    # 规范 origin 下的登录入口：从其他端口 / 主机名进入时也会回到同一 origin，保证 cookie 与回调一致。
    return {
        "login_url": settings.pms_origin + "/api/v1/auth/login",
        # 登录页据此检查浏览器里是否已有 IAM 登录会话（有则直接单点登录，不再要求输入密码）
        "iam_session_url": settings.casdoor_issuer + "/api/get-account",
        # 保留兼容字段，旧前端也不能重新开放注册。
        "signup_enabled": False,
    }


@router.post("/register", deprecated=True)
def register():
    """旧客户端明确得到停用提示；不再接受注册资料或调用 IAM / 数据库建号。"""
    raise HTTPException(410, "所有用户信息在iam平台管理")


@router.get("/callback")
def callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    # 过渡门户复用已登记的回调，只按匹配的独立 state Cookie 分派；
    # 门户 handler 消费 portal_logins，不会读写 PM 登录状态或放宽 PM 准入。
    from app.api.v1.portal import PORTAL_LOGIN_COOKIE, handle_callback

    portal_state = request.cookies.get(PORTAL_LOGIN_COOKIE, "")
    if (
        not settings.PORTAL_PUBLIC_URL
        and state
        and portal_state
        and secrets.compare_digest(state.encode(), portal_state.encode())
    ):
        return handle_callback(request, code, state, error, db)
    cookie_state = request.cookies.get(LOGIN_COOKIE, "")
    if (
        not state
        or not cookie_state
        or not secrets.compare_digest(state.encode(), cookie_state.encode())
    ):
        return login_error("state")
    # 先原子消费 state，再换 code（防重放 / 重复回调）。
    transaction = db.execute(
        delete(IAMLogin)
        .where(IAMLogin.id == digest(state))
        .returning(IAMLogin.data, IAMLogin.expires_at)
    ).first()
    db.commit()
    if not transaction or transaction.expires_at < int(time.time()):
        return login_error("state")
    if error or not code:
        return login_error("cancelled")
    try:
        data = unseal(transaction.data)
        result = httpx.post(
            settings.casdoor_token_url,
            data={
                "grant_type": "authorization_code",
                "client_id": settings.CASDOOR_CLIENT_ID,
                "client_secret": settings.CASDOOR_CLIENT_SECRET,
                "code": code,
                "redirect_uri": settings.iam_callback_url,
                "code_verifier": data["verifier"],
            },
            timeout=10,
            trust_env=False,
        )
        result.raise_for_status()
        tokens = result.json()
        access = tokens["access_token"]
        claims = decode_access_token(access)
        from app.services.oidc_logout import ensure_not_revoked

        ensure_not_revoked(db, claims, settings.CASDOOR_CLIENT_ID)
        from app.services.oidc_status import ensure_active_token

        ensure_active_token(access, claims, expected_audience=settings.CASDOOR_CLIENT_ID)
        identity = decode_access_token(tokens["id_token"], access_token=access)
        if identity.get("nonce") != data["nonce"] or identity["sub"] != claims["sub"]:
            raise ValueError("identity verification failed")
        if identity.get("azp", settings.CASDOOR_CLIENT_ID) != settings.CASDOOR_CLIENT_ID:
            raise ValueError("invalid authorized party")
        resolve_identity(claims, db, bind=True)
        session_id = secrets.token_urlsafe(32)
        from app.services.iam_sessions import create_session_payload

        encrypted, expires = create_session_payload(tokens, claims, identity)
        # 每次成功登录都轮换本地会话。
        previous = request.cookies.get(SESSION_COOKIE)
        if previous:
            db.execute(delete(IAMSession).where(IAMSession.id == digest(previous)))
        db.add(
            IAMSession(
                id=digest(session_id),
                expires_at=expires,
                tokens=encrypted,
            )
        )
        db.commit()
    except HTTPException as exc:
        db.rollback()
        return login_error("role" if exc.status_code == 403 else "provider")
    except (httpx.HTTPError, ValueError, KeyError, TypeError, InvalidToken, IntegrityError):
        db.rollback()
        return login_error("provider")
    response = RedirectResponse(settings.pms_origin + safe_return_to(data["return_to"]), 303)
    response.delete_cookie(LOGIN_COOKIE, path="/")
    set_cookie(response, SESSION_COOKIE, session_id, max(0, expires - int(time.time())))
    return no_cache(response)


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db)):
    require_same_origin(request)
    if settings.OIDC_GLOBAL_LOGOUT_ENABLED:
        from app.services.oidc_logout import global_logout

        return global_logout(request, db)
    from app.api.v1.portal import (
        PORTAL_LOGIN_COOKIE,
        PORTAL_SESSION_COOKIE,
        clear_portal_state,
    )

    session_id = request.cookies.get(SESSION_COOKIE, "")
    session = db.get(IAMSession, digest(session_id)) if session_id else None
    params = {
        "client_id": settings.CASDOOR_CLIENT_ID,
        "post_logout_redirect_uri": settings.pms_origin + LOGIN_PAGE,
    }
    if session:
        db.delete(session)
    clear_portal_state(request, db)
    db.commit()
    response = RedirectResponse(settings.casdoor_issuer + "/api/logout?" + urlencode(params), 303)
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(LOGIN_COOKIE, path="/")
    response.delete_cookie(PORTAL_SESSION_COOKIE, path="/")
    response.delete_cookie(PORTAL_LOGIN_COOKIE, path="/")
    return no_cache(response)


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    identity = (
        db.query(IAMIdentity).filter_by(issuer=settings.casdoor_issuer, user_id=user.id).first()
    )
    return MeOut(
        **UserOut.model_validate(user).model_dump(),
        must_change_password=password_policy.change_required(db, identity and identity.subject),
    )


@router.post("/backchannel-logout")
async def backchannel_logout(request: Request, db: Annotated[Session, Depends(get_db)]):
    from app.services.oidc_logout import read_logout_form, receive_logout

    token = await read_logout_form(request)
    receive_logout(db, token)
    response = Response(content='{"status":"ok"}', media_type="application/json")
    return no_cache(response)


@router.post("/logout/local")
def logout_local(request: Request, db: Annotated[Session, Depends(get_db)]):
    require_same_origin(request)
    from app.services.oidc_logout import local_logout

    return local_logout(request, db)
