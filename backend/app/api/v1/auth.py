"""IAM 登录（mb-casd / Casdoor）：授权码 + PKCE S256，由后端换取令牌，令牌不出服务端。

路由：
    GET  /api/v1/auth/login      生成 state / nonce / PKCE，302 到 Casdoor 授权页
    GET  /api/v1/auth/config     前端获取规范登录入口（保证 cookie 与回调同一 origin）、是否开放注册
    POST /api/v1/auth/register   自助注册：在 IAM 本组织建号 + 分配执行层默认角色 + 建业务账号
    GET  /api/v1/auth/callback   校验 state → 换 token → 验签 + nonce → 建立 HttpOnly 会话
    POST /api/v1/auth/logout     销毁业务会话，再跳 Casdoor /api/logout 清 SSO
    GET  /api/v1/auth/me         当前用户（角色取自 IAM）
"""

import base64
import hashlib
import secrets
import threading
import time
from urllib.parse import urlencode
from uuid import uuid4

import httpx
from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, func
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
from app.schemas.account import RegisterInput
from app.schemas.user import UserOut
from app.services import iam_admin
from app.services.iam_admin import IAMError

router = APIRouter(prefix="/auth", tags=["auth"])

LOGIN_PAGE = "/login"
# 自助注册只能得到执行层角色；管理角色（admin / cmc_lead / project_lead）须由 IAM 管理员分配。
SIGNUP_ROLES = {"rd", "production", "qa_qc"}
SIGNUP_WINDOW, SIGNUP_LIMIT = 600, 10  # 同一来源 IP 每 10 分钟最多 10 次注册请求
AVATAR_COLORS = ["#2563eb", "#0ea5e9", "#06b6d4", "#14b8a6", "#10b981", "#22c55e", "#84cc16"]
AVATAR_COLORS += ["#eab308", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#6366f1"]
_signup_hits: dict[str, list[float]] = {}
_signup_lock = threading.Lock()


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


@router.get("/login")
def login(db: Session = Depends(get_db), return_to: str = Query("/", max_length=2048)):
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
    params = {
        "client_id": settings.CASDOOR_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": settings.iam_callback_url,
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    response = RedirectResponse(
        settings.casdoor_issuer + "/login/oauth/authorize?" + urlencode(params), 303
    )
    set_cookie(response, LOGIN_COOKIE, state, 600)
    return no_cache(response)


@router.get("/config")
def config():
    # 规范 origin 下的登录入口：从其他端口 / 主机名进入时也会回到同一 origin，保证 cookie 与回调一致。
    return {
        "login_url": settings.pms_origin + "/api/v1/auth/login",
        "signup_enabled": settings.IAM_SIGNUP_ENABLED and bool(settings.CASDOOR_CLIENT_SECRET),
    }


def throttle_signup(request: Request) -> None:
    key = request.client.host if request.client else "-"
    now = time.monotonic()
    with _signup_lock:
        if len(_signup_hits) > 1000:  # 顺带清掉早已过窗的来源，防止无界增长
            for stale in [k for k, v in _signup_hits.items() if now - v[-1] > SIGNUP_WINDOW]:
                del _signup_hits[stale]
        hits = [t for t in _signup_hits.get(key, []) if now - t < SIGNUP_WINDOW]
        if len(hits) >= SIGNUP_LIMIT:
            raise HTTPException(429, "注册请求过于频繁，请稍后再试")
        _signup_hits[key] = [*hits, now]


@router.post("/register", status_code=201)
def register(payload: RegisterInput, request: Request, db: Session = Depends(get_db)):
    """IAM 账号与业务账号一起建：新账号的 IAM id 预先绑定到新业务用户，登录后直接可用。

    用户名 / 邮箱与已有业务用户（含尚未开通 IAM 的预置用户）冲突即拒绝，杜绝抢注他人账号。
    任一步失败都回滚：删除本次创建的 IAM 账号，不留半成品。
    """
    require_same_origin(request)
    if not settings.IAM_SIGNUP_ENABLED:
        raise HTTPException(403, "当前未开放自助注册，请联系管理员开通账号")
    role = settings.IAM_SIGNUP_ROLE
    if role not in SIGNUP_ROLES:
        raise HTTPException(503, "自助注册的默认角色配置无效，请联系管理员")
    throttle_signup(request)
    if db.query(User.id).filter(func.lower(User.username) == payload.username).first():
        raise HTTPException(409, "该用户名已被占用")
    if db.query(User.id).filter(func.lower(User.email) == payload.email).first():
        raise HTTPException(409, "该邮箱已被其他账号使用")

    subject = str(uuid4())
    try:
        iam_admin.create_user(
            subject, payload.username, payload.display_name, payload.email, payload.password
        )
    except IAMError as exc:  # IAM 拒绝（如同名 / 同邮箱账号已存在），未建号
        raise HTTPException(409, str(exc)) from exc
    except HTTPException:  # 结果不明（超时等）：若账号已按本次 id 建出则删掉
        iam_admin.discard_user(payload.username, subject)
        raise
    try:
        iam_admin.grant_role(payload.username, role)
        user = User(
            id=f"u-{uuid4().hex[:10]}",
            username=payload.username,
            display_name=payload.display_name,
            email=payload.email,
            role=role,
            weekly_available_hours=40,
            is_active=True,
            avatar_color=AVATAR_COLORS[int(digest(payload.username), 16) % len(AVATAR_COLORS)],
        )
        db.add(user)
        db.flush()
        db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=subject, user_id=user.id))
        db.commit()
    except Exception as exc:
        db.rollback()
        iam_admin.discard_user(payload.username, subject, role)
        if isinstance(exc, IAMError):
            raise HTTPException(503, "IAM 角色分配失败，请稍后重试") from exc
        if isinstance(exc, IntegrityError):
            raise HTTPException(409, "用户名或邮箱已被占用") from exc
        raise
    return {"username": payload.username, "role": role}


@router.get("/callback")
def callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    cookie_state = request.cookies.get(LOGIN_COOKIE, "")
    if not state or not cookie_state or not secrets.compare_digest(state, cookie_state):
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
        identity = decode_access_token(tokens["id_token"], access_token=access)
        if identity.get("nonce") != data["nonce"] or identity["sub"] != claims["sub"]:
            raise ValueError("identity verification failed")
        if identity.get("azp", settings.CASDOOR_CLIENT_ID) != settings.CASDOOR_CLIENT_ID:
            raise ValueError("invalid authorized party")
        resolve_identity(claims, db, bind=True)
        session_id = secrets.token_urlsafe(32)
        expires = min(int(claims["exp"]), int(time.time()) + settings.IAM_SESSION_SECONDS)
        # 每次成功登录都轮换本地会话。
        previous = request.cookies.get(SESSION_COOKIE)
        if previous:
            db.execute(delete(IAMSession).where(IAMSession.id == digest(previous)))
        db.add(
            IAMSession(
                id=digest(session_id),
                expires_at=expires,
                tokens=seal({"access_token": access, "id_token": tokens["id_token"]}),
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
    session_id = request.cookies.get(SESSION_COOKIE, "")
    session = db.get(IAMSession, digest(session_id)) if session_id else None
    params = {
        "client_id": settings.CASDOOR_CLIENT_ID,
        "post_logout_redirect_uri": settings.pms_origin + LOGIN_PAGE,
    }
    if session:
        try:
            params["id_token_hint"] = unseal(session.tokens)["id_token"]
        except (InvalidToken, ValueError, KeyError):
            pass
        db.delete(session)
        db.commit()
    response = RedirectResponse(settings.casdoor_issuer + "/api/logout?" + urlencode(params), 303)
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(LOGIN_COOKIE, path="/")
    return no_cache(response)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.model_validate(user)
