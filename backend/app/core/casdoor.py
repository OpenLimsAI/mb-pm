"""Casdoor access_token（RS256/JWKS）验签 + 角色提取。

JWKS 用标准库 urllib 拉取并进程内缓存（运行时不引入新依赖）；
验签用 python-jose（已含 cryptography）。
"""
import json
import urllib.request
from typing import Any

from jose import jwt
from jose.exceptions import JWTError

from app.core.config import settings

_ROLES = {"admin", "cmc_lead", "project_lead", "rd", "production", "qa_qc"}
_jwks_cache: dict | None = None


def _fetch_jwks() -> dict:
    with urllib.request.urlopen(settings.casdoor_jwks_url, timeout=5) as resp:
        return json.loads(resp.read().decode())


def _get_jwks(force: bool = False) -> dict:
    global _jwks_cache
    if _jwks_cache is None or force:
        _jwks_cache = _fetch_jwks()
    return _jwks_cache


def verify_casdoor_token(token: str) -> dict[str, Any]:
    """验签并返回 claims；失败抛 ValueError。kid 未命中时刷新一次 JWKS。"""
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")

        last: Exception = ValueError("no JWKS available")
        for force in (False, True):
            jwks = _get_jwks(force=force)
            # 按 kid 选择单个 JWK；若没有 kid 则尝试所有 keys
            keys = jwks.get("keys", [])
            if kid:
                candidates = [k for k in keys if k.get("kid") == kid]
            else:
                candidates = keys

            if not candidates and force:
                break

            for key in candidates:
                try:
                    return jwt.decode(
                        token,
                        key,
                        algorithms=["RS256"],
                        audience=settings.CASDOOR_CLIENT_ID,
                        issuer=settings.CASDOOR_ENDPOINT,
                        options={"verify_at_hash": False},
                    )
                except JWTError as e:
                    last = e

        raise ValueError(f"Casdoor token 验签失败: {last}")
    except JWTError as exc:
        raise ValueError(f"Casdoor token 解析失败: {exc}") from exc


def extract_role(claims: dict[str, Any]) -> str | None:
    """从 claims 取出 6 个角色名之一。兼容 roles=[{name}]、roles=[str]、role=str。"""
    roles = claims.get("roles")
    if isinstance(roles, list):
        for r in roles:
            name = r.get("name") if isinstance(r, dict) else r
            if name in _ROLES:
                return name
    role = claims.get("role")
    if role in _ROLES:
        return role
    return None
