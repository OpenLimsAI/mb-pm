"""mb-casd / Casdoor IAM：RS256 JWT 验签、身份映射、会话令牌加密。

- 角色只信任经验签的 IAM token（roles[].name，owner 须为本组织，且唯一），
  不信任本地 users.role，也不从浏览器接收任何身份信息。
- 首次登录按组织内用户名关联**已预置**的业务用户，之后固定按 issuer + sub 绑定。
- access / id token 以 APP_SECRET 派生的密钥加密后存库，浏览器只拿随机会话 ID。
"""

import base64
import hashlib
import json
import threading
import time

import httpx
from cryptography.fernet import Fernet
from fastapi import HTTPException
from jose import JWTError, jwt
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import settings
from app.models import IAMIdentity, User

ROLES = {"admin", "cmc_lead", "project_lead", "rd", "production", "qa_qc"}
# 同时持有多个项目管理角色时取最高的；没有项目管理角色时按「员工」（rd：更新本人任务等日常录入）。
# 项目管理默认对组织内所有人开放，账号管理里只区分 系统管理员 / 项目负责人 / 员工。
ROLE_PRIORITY = ("admin", "cmc_lead", "project_lead", "qa_qc", "production", "rd")
DEFAULT_ROLE = "rd"
SESSION_COOKIE = "mbpm_iam_session"
LOGIN_COOKIE = "mbpm_iam_login"
_jwks_cache: dict = {}
_jwks_lock = threading.Lock()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def cipher() -> Fernet:
    if len(settings.APP_SECRET) < 32 or settings.APP_SECRET.startswith("change-me"):
        raise HTTPException(503, "IAM 会话密钥未配置")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.APP_SECRET.encode()).digest()))


def seal(value: dict) -> str:
    return cipher().encrypt(json.dumps(value).encode()).decode()


def unseal(value: str) -> dict:
    return json.loads(cipher().decrypt(value.encode()))


def signing_key(kid: str, *, jwks_url: str | None = None) -> dict:
    url = jwks_url or settings.casdoor_jwks_url
    with _jwks_lock:
        now = time.monotonic()
        cached = _jwks_cache.get(url)
        # 缓存 5 分钟；遇到未知 kid 视为密钥轮换，最多每 30 秒刷新一次。
        if (
            not cached
            or now - cached[0] > 300
            or (not any(k.get("kid") == kid for k in cached[1]) and now - cached[0] > 30)
        ):
            try:
                response = httpx.get(url, timeout=5, trust_env=False)
                response.raise_for_status()
                keys = response.json()["keys"]
                if not isinstance(keys, list) or not all(isinstance(k, dict) for k in keys):
                    raise ValueError("invalid JWKS")
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                raise HTTPException(503, "IAM 公钥服务暂时不可用") from exc
            cached = (now, keys)
            _jwks_cache[url] = cached
        matches = [
            k
            for k in cached[1]
            if k.get("kid") == kid
            and k.get("kty") == "RSA"
            and k.get("use", "sig") == "sig"
            and k.get("alg", "RS256") == "RS256"
        ]
        if len(matches) != 1:
            raise HTTPException(401, "无效的 IAM 签名密钥")
        return matches[0]


def decode_access_token(
    token: str,
    *,
    access_token: str | None = None,
    audience: str | None = None,
    jwks_url: str | None = None,
    allow_expired: bool = False,
) -> dict:
    if not token or len(token) > 32768:
        raise HTTPException(401, "无效的 IAM 令牌")
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise JWTError("unsupported signing algorithm")
        claims = jwt.decode(
            token,
            signing_key(header["kid"], jwks_url=jwks_url),
            algorithms=["RS256"],
            audience=audience or settings.CASDOOR_CLIENT_ID,
            issuer=settings.casdoor_issuer,
            access_token=access_token,
            options={
                # python-jose makes require_exp force verify_exp back to True.
                # Renewal still requires a signed integer exp below, but may
                # inspect an expired access JWT solely to bind a refresh grant.
                "require_exp": not allow_expired,
                "require_sub": True,
                "require_aud": True,
                "require_iss": True,
                "leeway": 10,
                "verify_exp": not allow_expired,
            },
        )
        if not claims.get("sub"):
            raise JWTError("empty subject")
        if allow_expired and (
            not isinstance(claims.get("exp"), int)
            or isinstance(claims["exp"], bool)
            or claims["exp"] <= 0
        ):
            raise JWTError("missing or invalid expiry")
        return claims
    except (JWTError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(401, "IAM 令牌无效或已过期") from exc


def pm_role(claims: dict) -> str:
    """当前身份中本组织启用的最高项目角色；生产请求以实时 IAM 状态覆盖 JWT 快照。"""
    entries = claims.get("roles")
    held = {
        r.get("name")
        for r in (entries if isinstance(entries, list) else [])
        if isinstance(r, dict)
        and r.get("owner") == settings.CASDOOR_ORG
        and r.get("isEnabled", True) is True
    }
    return next((role for role in ROLE_PRIORITY if role in held), DEFAULT_ROLE)


def resolve_identity(claims: dict, db: Session, *, bind: bool = False) -> User:
    if claims.get("owner") != settings.CASDOOR_ORG:
        raise HTTPException(403, "该 IAM 账号不属于项目管理组织")
    if claims.get("isForbidden") or claims.get("isDeleted"):
        raise HTTPException(403, "IAM 账号已停用")
    role = pm_role(claims)
    subject = claims["sub"]
    issuer = settings.casdoor_issuer
    if len(subject) > 255:
        raise HTTPException(401, "无效的 IAM 用户标识")
    identity = db.get(IAMIdentity, (issuer, subject))
    if identity:
        user = db.get(User, identity.user_id)
        if bind and user:
            # 登录时以 IAM 为准：同步用户名与姓名；令牌未标记停用说明账号已启用，成员随之启用
            from app.services.members import sync_profile

            sync_profile(db, user, claims)
            user.is_active = True
    elif bind:
        # 首次登录：已有同名且未绑定的成员（如历史预置）则绑定；没有就按 IAM 资料新建成员。
        # 只信任经验签的令牌（sub / name 来自 IAM），不接受浏览器传来的身份。
        from app.services.members import create_member, username_taken

        name = claims.get("name")
        if not isinstance(name, str) or not name or len(name) > 50:
            raise HTTPException(403, "IAM 用户资料不完整")
        user = db.query(User).filter_by(username=name).first()
        if user and db.query(IAMIdentity).filter_by(issuer=issuer, user_id=user.id).first():
            raise HTTPException(403, "此业务账号已绑定其他 IAM 身份，请联系管理员")
        if user:
            db.add(IAMIdentity(issuer=issuer, subject=subject, user_id=user.id))
        elif username_taken(db, name):
            raise HTTPException(403, "项目管理中已有同名成员，请联系管理员核对")
        else:
            display = claims.get("displayName")
            user = create_member(
                db,
                subject,
                name,
                display if isinstance(display, str) else name,
                claims.get("email"),
                role,
            )
    else:
        user = None
    if not user or not user.is_active:
        raise HTTPException(403, "此 IAM 账号尚未关联有效的项目管理用户")
    # 授权只认 IAM 角色：仅覆盖本请求内的对象，不写回 users 表。
    set_committed_value(user, "role", role)
    return user
