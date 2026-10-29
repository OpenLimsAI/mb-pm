"""mb-casd JWT verification, identity mapping and encrypted session storage."""

import base64
import hashlib
import json
import threading
import time
from uuid import uuid4

import httpx
from cryptography.fernet import Fernet
from fastapi import HTTPException
from jose import JWTError, jwt
from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import settings
from app.models import IAMIdentity, User

ROLES = {"admin", "cmc_lead", "project_lead", "rd", "production", "qa_qc"}
SESSION_COOKIE = "pms_lite_iam_session"
LOGIN_COOKIE = "pms_lite_iam_login"
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


def signing_key(kid: str) -> dict:
    url = settings.casdoor_jwks_url
    with _jwks_lock:
        now = time.monotonic()
        cached = _jwks_cache.get(url)
        # Unknown kids may trigger a rotation refresh, bounded to once per 30s.
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


def decode_access_token(token: str, *, access_token: str | None = None) -> dict:
    if not token or len(token) > 32768:
        raise HTTPException(401, "无效的 IAM 令牌")
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise JWTError("unsupported signing algorithm")
        claims = jwt.decode(
            token,
            signing_key(header["kid"]),
            algorithms=["RS256"],
            audience=settings.CASDOOR_CLIENT_ID,
            issuer=settings.CASDOOR_ENDPOINT,
            access_token=access_token,
            options={
                "require_exp": True,
                "require_sub": True,
                "require_aud": True,
                "require_iss": True,
                "leeway": 10,
            },
        )
        if not claims.get("sub"):
            raise JWTError("empty subject")
        return claims
    except (JWTError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(401, "IAM 令牌无效或已过期") from exc


def resolve_identity(claims: dict, db: Session, *, bind: bool = False) -> User:
    if claims.get("owner") != settings.CASDOOR_ORGANIZATION:
        raise HTTPException(403, "该 IAM 账号不属于项目管理组织")
    if claims.get("isForbidden") or claims.get("isDeleted"):
        raise HTTPException(403, "IAM 账号已停用")
    entries = claims.get("roles")
    if entries is None:
        entries = []
    if not isinstance(entries, list):
        raise HTTPException(403, "IAM 角色格式无效")
    roles = {
        r.get("name")
        for r in entries
        if isinstance(r, dict)
        and r.get("owner") == settings.CASDOOR_ORGANIZATION
        and r.get("isEnabled", True) is True
        and isinstance(r.get("name"), str)
        and r["name"] in ROLES
    }
    if len(roles) > 1:
        raise HTTPException(403, "IAM 账号只能分配一个项目管理角色")
    if entries and not roles:
        raise HTTPException(403, "IAM 角色未启用或不属于当前业务组织")
    assigned_role = next(iter(roles)) if roles else "rd"
    subject = claims["sub"]
    issuer = settings.CASDOOR_ENDPOINT
    if len(subject) > 255:
        raise HTTPException(401, "无效的 IAM 用户标识")
    identity = db.get(IAMIdentity, (issuer, subject))
    if identity:
        user = db.get(User, identity.user_id)
    elif bind:
        name = claims.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 50:
            raise HTTPException(403, "IAM 用户名无效或过长")
        name = name.strip()
        existing = db.query(User).filter(func.lower(User.username) == name.lower()).first()
        # Only the six pre-existing, explicitly role-assigned IAM identities may
        # bind seeded business users. Public signup never claims a seeded user.
        legacy = {"admin", "guo.cmc", "li.pm1", "liu.usp1", "mao.prod1", "qa.zhao"}
        if existing:
            if not roles or name not in legacy or existing.role != assigned_role:
                raise HTTPException(403, "该用户名已被业务账号使用，请联系管理员关联身份")
            if db.query(IAMIdentity).filter_by(issuer=issuer, user_id=existing.id).first():
                raise HTTPException(403, "此业务账号已绑定其他 IAM 身份")
            user = existing
        else:
            uid = "u-" + uuid4().hex[:14]
            email = claims.get("email") or f"{uid}@users.example.com"
            if db.query(User).filter(func.lower(User.email) == email.lower()).first():
                raise HTTPException(403, "该邮箱已被业务账号使用，请联系管理员；不会按邮箱合并账号")
            user = User(
                id=uid,
                username=name,
                display_name=(claims.get("displayName") or name)[:50],
                email=email,
                role=assigned_role,
                is_active=True,
                weekly_available_hours=40,
            )
            db.add(user)
            db.flush()
        db.add(IAMIdentity(issuer=issuer, subject=subject, user_id=user.id))
    else:
        user = None
    if not user or not user.is_active:
        raise HTTPException(403, "此 IAM 账号尚未关联有效的项目管理用户")
    if bind:
        # IAM subject is stable across username changes; business IDs and all
        # project/member/task relationships remain unchanged.
        name = claims.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 50:
            raise HTTPException(403, "IAM 用户名无效或过长")
        clash = (
            db.query(User)
            .filter(func.lower(User.username) == name.lower(), User.id != user.id)
            .first()
        )
        if clash:
            raise HTTPException(403, "新的用户名与其他业务账号冲突，请联系管理员")
        user.username = name
        user.display_name = (claims.get("displayName") or user.display_name)[:50]
        user.role = assigned_role
    else:
        # Claims are server-verified; browser and local role fields cannot elevate access.
        set_committed_value(user, "role", assigned_role)
    return user
