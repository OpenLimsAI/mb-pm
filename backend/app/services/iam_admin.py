"""Casdoor 管理接口：本人改用户名 / 改密码（仅后端调用）。

以应用的 client id / secret 调用 Casdoor —— 应用凭据在 Casdoor 中具备管理权限，
所以这里只提供少数几个固定操作，目标一律限定在本组织（CASDOOR_ORG）：
改名 / 改密的账号由调用方按当前登录用户的 IAM sub 定位，绝不接受浏览器传来的用户标识。

Casdoor 业务失败时 HTTP 仍为 200、status=error，msg 按 Accept-Language 返回中文说明。
"""

import logging

import httpx
from fastapi import HTTPException

from app.core.config import settings

log = logging.getLogger(__name__)


class IAMError(Exception):
    """Casdoor 拒绝了操作（用户名已存在、密码错误等）；str(exc) 为 Casdoor 返回的说明。"""


def _call(method: str, path: str, **kwargs) -> dict:
    if not settings.CASDOOR_CLIENT_SECRET:
        raise HTTPException(503, "IAM 客户端尚未配置")
    try:
        response = httpx.request(
            method,
            f"{settings.casdoor_internal_url}/api/{path}",
            auth=(settings.CASDOOR_CLIENT_ID, settings.CASDOOR_CLIENT_SECRET),
            headers={"Accept-Language": "zh"},
            timeout=10,
            trust_env=False,
            **kwargs,
        )
        response.raise_for_status()
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("Casdoor %s %s 调用失败：%s", method, path, exc)
        raise HTTPException(503, "IAM 服务暂时不可用，请稍后重试") from exc
    if not isinstance(body, dict):
        raise HTTPException(503, "IAM 服务返回异常，请稍后重试")
    if body.get("status") != "ok":
        raise IAMError(str(body.get("msg") or "IAM 拒绝了该操作"))
    return body


def _member(name: str) -> str:
    return f"{settings.CASDOOR_ORG}/{name}"


def get_user_by_sub(subject: str) -> dict:
    """按 IAM sub（Casdoor 用户 id）取本组织账号。"""
    user = _call("GET", "get-user", params={"owner": settings.CASDOOR_ORG, "userId": subject}).get(
        "data"
    )
    if (
        not isinstance(user, dict)
        or user.get("id") != subject
        or user.get("owner") != settings.CASDOOR_ORG
        or not isinstance(user.get("name"), str)
    ):
        raise HTTPException(409, "未在 IAM 中找到当前账号，请重新登录后再试")
    return user


def get_user_by_name(name: str) -> dict | None:
    user = _call("GET", "get-user", params={"id": _member(name)}).get("data")
    if isinstance(user, dict) and user.get("owner") == settings.CASDOOR_ORG:
        return user if user.get("name") == name else None
    return None


def verify_password(name: str, password: str) -> None:
    """校验当前密码；错误次数计入 Casdoor 的登录失败锁定。"""
    _call(
        "POST",
        "check-user-password",
        json={"owner": settings.CASDOOR_ORG, "name": name, "password": password},
    )


def set_password(name: str, old_password: str, new_password: str) -> None:
    """Casdoor 会再次校验旧密码，并执行组织的密码复杂度与「不得与原密码相同」规则。"""
    _call(
        "POST",
        "set-password",
        data={
            "userOwner": settings.CASDOOR_ORG,
            "userName": name,
            "oldPassword": old_password,
            "newPassword": new_password,
        },
    )


def rename_user(subject: str, new_name: str) -> None:
    """按 sub 定位改名；Casdoor 同步改写角色 / 权限成员，用户 id（sub）不变。"""
    body = _call(
        "POST",
        "update-user",
        params={"owner": settings.CASDOOR_ORG, "userId": subject, "columns": "name"},
        json={"owner": settings.CASDOOR_ORG, "name": new_name},
    )
    if body.get("data") != "Affected":
        raise IAMError("IAM 未能修改用户名，请稍后重试")


def name_shared_across_orgs(name: str) -> bool:
    """Casdoor 改名时按用户名（不分组织）改写所有角色 / 权限成员。其他组织的角色或权限中
    若有同名成员，改名会误改它们 —— 调用方据此拒绝自助改名。"""
    for path in ("get-roles", "get-permissions"):
        for item in _call("GET", path, params={"owner": ""}).get("data") or []:
            members = item.get("users") if isinstance(item, dict) else None
            for member in members or []:
                owner, _, member_name = str(member).partition("/")
                if member_name == name and owner != settings.CASDOOR_ORG:
                    return True
    return False
