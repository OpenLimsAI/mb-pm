"""迈博应用门户：仅验证企业身份，应用仍独立检查其业务权限。

生产门户使用 www.openlims.ai、独立 OIDC client / audience 和 /portal/callback。
本地同域过渡模式可复用 PM client；登录状态、会话表和 Cookie 始终独立。
"""

import base64
import hashlib
import json
import secrets
import time
from typing import Annotated
from urllib.parse import urlencode

import httpx
from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import delete, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import require_same_origin
from app.api.v1.auth import no_cache, safe_return_to, set_cookie
from app.core.config import settings
from app.core.security import (
    LOGIN_COOKIE,
    SESSION_COOKIE,
    decode_access_token,
    digest,
    pm_role,
    seal,
    unseal,
)
from app.db.session import get_db
from app.models import IAMIdentity, IAMSession, PortalLogin, PortalSession, User
from app.schemas.account import PasswordChange
from app.schemas.auth import LoginStart
from app.schemas.portal import PortalApplicationOut, PortalMeOut, PortalUserOut
from app.services import iam_login, password_policy
from app.services.iam_admin import IAMError

router = APIRouter(prefix="/portal", tags=["portal"])
PORTAL_LOGIN_COOKIE = "mbportal_iam_login"
PORTAL_SESSION_COOKIE = "mbportal_iam_session"


def require_configuration() -> None:
    independent = settings.portal_origin != settings.pms_origin
    configured_client = bool(settings.PORTAL_CLIENT_ID and settings.PORTAL_CLIENT_SECRET)
    if independent and (
        not configured_client or settings.portal_client_id == settings.CASDOOR_CLIENT_ID
    ):
        raise HTTPException(503, "独立门户的 IAM 应用尚未配置，请联系管理员")
    if bool(settings.PORTAL_CLIENT_ID) != bool(settings.PORTAL_CLIENT_SECRET):
        raise HTTPException(503, "门户 IAM 应用配置不完整")
    if not settings.portal_client_secret:
        raise HTTPException(503, "IAM 客户端尚未配置")


def decode_portal_token(token: str, *, access_token: str | None = None) -> dict:
    return decode_access_token(
        token,
        access_token=access_token,
        audience=settings.portal_client_id,
        jwks_url=settings.PORTAL_JWKS_URL or None,
    )


def validate_identity(claims: dict) -> PortalUserOut:
    """门户准入不要求 PM 角色或业务用户，且不自动创建或赋权。"""
    if claims.get("owner") != settings.CASDOOR_ORG:
        raise HTTPException(403, "该 IAM 账号不属于迈博业务组织")
    if claims.get("isForbidden") or claims.get("isDeleted"):
        raise HTTPException(403, "IAM 账号已停用")
    subject, name = claims.get("sub"), claims.get("name")
    if not isinstance(subject, str) or not subject or len(subject) > 255:
        raise HTTPException(401, "无效的 IAM 用户标识")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(403, "IAM 用户资料不完整")
    display = claims.get("displayName")
    return PortalUserOut(
        id=subject,
        username=name,
        display_name=display if isinstance(display, str) and display.strip() else name,
    )


def current_user(claims: dict, db: Session, request: Request | None = None) -> PortalUserOut:
    """门户显示的身份。登录令牌里的用户名在本人改名后要到下次登录才更新：
    已绑定项目管理成员时以成员的用户名为准（改名时同步写入，并随 IAM 对账）；
    未绑定时用本会话里记下的新用户名（见 portal_settings.change_username）。"""
    user = validate_identity(claims)
    identity = db.get(IAMIdentity, (settings.casdoor_issuer, claims["sub"]))
    member = db.get(User, identity.user_id) if identity else None
    if member is not None:
        user.username = member.username
    elif request is not None and (renamed := session_data(request, db).get("username")):
        user.username = renamed
    return user


def session_data(request: Request, db: Session) -> dict:
    """当前门户会话里保存的数据（令牌与本人改名后的用户名）；会话无效时为空。"""
    session_id = request.cookies.get(PORTAL_SESSION_COOKIE, "")
    session = db.get(PortalSession, digest(session_id)) if session_id else None
    try:
        return unseal(session.tokens) if session else {}
    except (InvalidToken, ValueError, TypeError):
        return {}


# 工作台「设置 › AI 分析」可修改的角色（与项目管理 ai.config 一致）
AI_MANAGERS = ("admin", "cmc_lead", "project_lead")


def enabled_roles(claims: dict) -> set[str]:
    entries = claims.get("roles")
    if not isinstance(entries, list):
        return set()
    return {
        role["name"]
        for role in entries
        if isinstance(role, dict)
        and role.get("owner") == settings.CASDOOR_ORG
        and role.get("isEnabled", True) is True
        and isinstance(role.get("name"), str)
    }


def mdm_entry() -> PortalApplicationOut:
    from app.services.mdm_links import mdm_base

    try:
        mdm_base()
        return PortalApplicationOut(id="mdm", enabled=True)
    except HTTPException:
        return PortalApplicationOut(
            id="mdm", enabled=False, reason="MDM 入口尚未配置；仍需独立 MDM 登录和权限"
        )


def applications(claims: dict, db: Session) -> list[PortalApplicationOut]:
    """项目管理默认对组织内所有人开放（首次进入时自动建成员）；知识库看 KB 角色。"""
    roles = enabled_roles(claims)
    pm_reason = None
    identity = db.get(IAMIdentity, (settings.casdoor_issuer, claims["sub"]))
    if identity:
        user = db.get(User, identity.user_id)
        if not user or not user.is_active:
            pm_reason = "项目管理账号已停用，请联系系统管理员"
    else:
        # 与 PM 首次登录规则一致，仅核对能否关联或新建，目录查询不建立绑定。
        user = db.query(User).filter(func.lower(User.username) == claims["name"].lower()).first()
        if user and (
            user.username != claims["name"]
            or db.query(IAMIdentity)
            .filter_by(issuer=settings.casdoor_issuer, user_id=user.id)
            .first()
        ):
            pm_reason = "项目管理中已有同名成员，请联系系统管理员核对"
        elif user and not user.is_active:
            pm_reason = "项目管理账号已停用，请联系系统管理员"
    kb_enabled = bool(roles & {"kb_manager", "kb_viewer", "kb_editor"})
    managers = bool(roles & {"admin", "cmc_lead", "project_lead"})
    # KB 原生应用仍是最终权限边界。没有明确 KB 角色时，不猜测默认阅读授权。
    return [
        PortalApplicationOut(id="pm", enabled=pm_reason is None, reason=pm_reason),
        mdm_entry(),
        PortalApplicationOut(
            id="kb",
            enabled=kb_enabled,
            reason=None if kb_enabled else "知识库尚未开通，请联系系统管理员",
        ),
        # 信息获取供组织成员浏览；管理与后台采集另行实时核对 admin / kb_manager。
        PortalApplicationOut(id="information", enabled=True),
        # 方案应用面向组织成员；方案所有权与知识来源权限由其接口独立检查。
        PortalApplicationOut(id="solutions", enabled=True),
        # 仅决定是否显示入口；账号管理接口每次请求都向 IAM 实时核对身份
        PortalApplicationOut(
            id="accounts",
            enabled=managers,
            reason=None if managers else "仅系统管理员和项目负责人可用",
        ),
    ]


def login_error(code: str):
    response = RedirectResponse(
        settings.portal_origin + "/login?" + urlencode({"error": code}), 303
    )
    response.delete_cookie(PORTAL_LOGIN_COOKIE, path="/")
    response.delete_cookie(PORTAL_SESSION_COOKIE, path="/")
    return no_cache(response)


@router.get("/config")
def config():
    return {
        "login_url": settings.portal_origin + "/api/v1/portal/login",
        # 登录页据此检查浏览器里是否已有 IAM 登录会话（有则直接单点登录，不再要求输入密码）
        "iam_session_url": settings.casdoor_issuer + "/api/get-account",
    }


def begin_login(db: Session, return_to: str) -> dict:
    """生成 state / PKCE / nonce 并保存门户登录事务，返回 IAM 授权参数（跳转登录页与嵌入式登录共用）。"""
    require_configuration()
    state, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
    now = int(time.time())
    data = seal({"verifier": verifier, "nonce": nonce, "return_to": safe_return_to(return_to)})
    db.execute(delete(PortalLogin).where(PortalLogin.expires_at < now))
    db.execute(delete(PortalSession).where(PortalSession.expires_at < now))
    db.add(PortalLogin(id=digest(state), data=data, expires_at=now + 600))
    db.commit()
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    return {
        "client_id": settings.portal_client_id,
        "response_type": "code",
        "redirect_uri": settings.portal_callback_url,
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }


@router.get("/login")
def login(
    db: Session = Depends(get_db),
    return_to: str = Query("/", max_length=2048),
):
    params = begin_login(db, return_to)
    response = RedirectResponse(
        settings.casdoor_issuer + "/login/oauth/authorize?" + urlencode(params), 303
    )
    set_cookie(response, PORTAL_LOGIN_COOKIE, params["state"], 600)
    return no_cache(response)


@router.post("/login/start")
def login_start(
    request: Request, body: LoginStart, response: Response, db: Session = Depends(get_db)
):
    """嵌入式登录：门户登录页直接输入用户名 / 密码（见 services/iam_login.py）。"""
    require_same_origin(request, origin=settings.portal_origin)
    params = begin_login(db, body.return_to)
    set_cookie(response, PORTAL_LOGIN_COOKIE, params["state"], 600)
    no_cache(response)
    return iam_login.embedded_login(params)


def handle_callback(request: Request, code: str, state: str, error: str, db: Session):
    require_configuration()
    cookie_state = request.cookies.get(PORTAL_LOGIN_COOKIE, "")
    if (
        not state
        or not cookie_state
        or not secrets.compare_digest(state.encode(), cookie_state.encode())
    ):
        return login_error("state")
    transaction = db.execute(
        delete(PortalLogin)
        .where(PortalLogin.id == digest(state))
        .returning(PortalLogin.data, PortalLogin.expires_at)
    ).first()
    db.commit()
    if not transaction or transaction.expires_at <= int(time.time()):
        return login_error("state")
    if error or not code:
        return login_error("cancelled")
    try:
        data = unseal(transaction.data)
        result = httpx.post(
            settings.casdoor_token_url,
            data={
                "grant_type": "authorization_code",
                "client_id": settings.portal_client_id,
                "client_secret": settings.portal_client_secret,
                "code": code,
                "redirect_uri": settings.portal_callback_url,
                "code_verifier": data["verifier"],
            },
            timeout=10,
            trust_env=False,
        )
        result.raise_for_status()
        tokens = result.json()
        access = tokens["access_token"]
        claims = decode_portal_token(access)
        identity = decode_portal_token(tokens["id_token"], access_token=access)
        if identity.get("nonce") != data["nonce"] or identity["sub"] != claims["sub"]:
            raise ValueError("identity verification failed")
        for verified in (claims, identity):
            if verified.get("azp", settings.portal_client_id) != settings.portal_client_id:
                raise ValueError("invalid authorized party")
        validate_identity(claims)
        expires = min(
            int(claims["exp"]),
            int(identity["exp"]),
            int(time.time()) + settings.IAM_SESSION_SECONDS,
        )
        if expires <= int(time.time()):
            raise ValueError("expired token")
        session_id = secrets.token_urlsafe(32)
        previous = request.cookies.get(PORTAL_SESSION_COOKIE)
        if previous:
            db.execute(delete(PortalSession).where(PortalSession.id == digest(previous)))
        db.add(
            PortalSession(
                id=digest(session_id),
                expires_at=expires,
                tokens=seal({"access_token": access, "id_token": tokens["id_token"]}),
            )
        )
        db.commit()
    except HTTPException as exc:
        db.rollback()
        return login_error("organization" if exc.status_code == 403 else "provider")
    except (httpx.HTTPError, ValueError, KeyError, TypeError, InvalidToken, IntegrityError):
        db.rollback()
        return login_error("provider")
    response = RedirectResponse(settings.portal_origin + safe_return_to(data["return_to"]), 303)
    response.delete_cookie(PORTAL_LOGIN_COOKIE, path="/")
    set_cookie(response, PORTAL_SESSION_COOKIE, session_id, expires - int(time.time()))
    return no_cache(response)


@router.get("/callback")
def callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    return handle_callback(request, code, state, error, db)


def session_claims(request: Request, db: Session) -> dict:
    """当前门户会话的已验签令牌声明；同时重新校验组织与账号状态。"""
    require_configuration()
    session_id = request.cookies.get(PORTAL_SESSION_COOKIE, "")
    session = db.get(PortalSession, digest(session_id)) if session_id else None
    if not session or session.expires_at <= int(time.time()):
        raise HTTPException(401, "请先登录迈博工作台")
    try:
        claims = decode_portal_token(unseal(session.tokens)["access_token"])
    except (InvalidToken, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(401, "登录会话已失效") from exc
    validate_identity(claims)
    return claims


@router.get("/applications/mdm/launch")
def mdm_launch(request: Request, db: Annotated[Session, Depends(get_db)]):
    from app.services.mdm_links import mdm_url

    claims = session_claims(request, db)
    password_policy.enforce(db, claims["sub"], request.url.path)
    return no_cache(JSONResponse({"url": mdm_url()}))


@router.get("/me", response_model=PortalMeOut, response_model_exclude_none=True)
def me(request: Request, db: Session = Depends(get_db)):
    claims = session_claims(request, db)
    # 账号管理保存后的入口缓存只影响目录显示，不能用于任何业务操作授权。
    catalogue_roles = session_data(request, db).get("catalogue_roles")
    directory_claims = (
        {**claims, "roles": catalogue_roles} if isinstance(catalogue_roles, list) else claims
    )
    return PortalMeOut(
        user=current_user(claims, db, request),
        identity_namespace=hashlib.sha256(
            json.dumps(
                [claims["iss"], claims["owner"], claims["sub"]],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest(),
        applications=applications(directory_claims, db),
        must_change_password=password_policy.change_required(db, claims["sub"]),
        can_configure_ai=pm_role(claims) in AI_MANAGERS,
    )


@router.post("/password", status_code=204)
def change_password(payload: PasswordChange, request: Request, db: Session = Depends(get_db)):
    """本人在门户里改密码（须当前密码）：清除临时密码标记，其他设备上的登录退出。"""
    require_same_origin(request, origin=settings.portal_origin)
    claims = session_claims(request, db)
    keep = {
        digest(c)
        for c in (request.cookies.get(PORTAL_SESSION_COOKIE), request.cookies.get(SESSION_COOKIE))
        if c
    }
    try:
        password_policy.change_own_password(
            db, claims["sub"], payload.current_password, payload.new_password, keep
        )
    except IAMError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db)):
    require_configuration()
    require_same_origin(request, origin=settings.portal_origin)
    params = {
        "client_id": settings.portal_client_id,
        "post_logout_redirect_uri": settings.portal_origin + "/login",
    }
    session_id = request.cookies.get(PORTAL_SESSION_COOKIE, "")
    session = db.get(PortalSession, digest(session_id)) if session_id else None
    if session:
        try:
            params["id_token_hint"] = unseal(session.tokens)["id_token"]
        except (InvalidToken, ValueError, KeyError, TypeError):
            pass
    clear_portal_state(request, db)
    pm_session_id = request.cookies.get(SESSION_COOKIE, "")
    if pm_session_id:
        db.execute(delete(IAMSession).where(IAMSession.id == digest(pm_session_id)))
    db.commit()
    response = RedirectResponse(settings.casdoor_issuer + "/api/logout?" + urlencode(params), 303)
    # 仅销毁本域当前会话并请求 IAM SSO 退出；其他子域的 PM / KB Cookie 不在本域控制范围内。
    for cookie in (PORTAL_SESSION_COOKIE, PORTAL_LOGIN_COOKIE, SESSION_COOKIE, LOGIN_COOKIE):
        response.delete_cookie(cookie, path="/")
    return no_cache(response)


def clear_portal_state(request: Request, db: Session) -> None:
    """只清除当前浏览器的本域门户状态，供门户及 PM 登出共同使用。"""
    for model, cookie in (
        (PortalSession, PORTAL_SESSION_COOKIE),
        (PortalLogin, PORTAL_LOGIN_COOKIE),
    ):
        value = request.cookies.get(cookie, "")
        if value:
            db.execute(delete(model).where(model.id == digest(value)))
