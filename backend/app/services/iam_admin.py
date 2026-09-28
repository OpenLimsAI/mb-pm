"""Casdoor 管理接口：自助注册、本人改用户名 / 改密码（仅后端调用）。

以应用的 client id / secret 调用 Casdoor —— 应用凭据在 Casdoor 中具备管理权限，
所以这里只提供少数几个固定操作，目标一律限定在本组织（CASDOOR_ORG）：
改名 / 改密的账号由调用方按当前登录用户的 IAM sub 定位，绝不接受浏览器传来的用户标识。

Casdoor 业务失败时 HTTP 仍为 200、status=error，msg 按 Accept-Language 返回中文说明。
"""

import logging
import threading

import httpx
from fastapi import HTTPException

from app.core.config import settings

log = logging.getLogger(__name__)
_role_lock = threading.Lock()


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


def create_user(subject: str, name: str, display_name: str, email: str, password: str) -> None:
    """建本组织普通账号。id 由我们生成：即登录后 token 的 sub，也用来认领 / 清理本次创建的账号。"""
    _call(
        "POST",
        "add-user",
        json={
            "owner": settings.CASDOOR_ORG,
            "id": subject,
            "name": name,
            "displayName": display_name,
            "email": email,
            "password": password,
            "type": "normal-user",
            "registerType": "PMS 自助注册",
        },
    )
    created = get_user_by_name(name)
    if not created or created.get("id") != subject:
        raise HTTPException(503, "IAM 账号创建结果异常，请联系管理员")


def _set_role_member(role: str, name: str, *, present: bool) -> None:
    """Casdoor 没有「加 / 移单个成员」接口，只能读改写整条角色；本进程内串行化。"""
    member = _member(name)
    with _role_lock:
        data = _call("GET", "get-role", params={"id": _member(role)}).get("data")
        if (
            not isinstance(data, dict)
            or data.get("owner") != settings.CASDOOR_ORG
            or data.get("name") != role
        ):
            raise HTTPException(503, f"IAM 中缺少角色 {role}，请联系管理员")
        users = [u for u in data.get("users") or [] if u != member]
        if present:
            users.append(member)
        _call("POST", "update-role", params={"id": _member(role)}, json={**data, "users": users})


def grant_role(name: str, role: str) -> None:
    _set_role_member(role, name, present=True)


def discard_user(name: str, subject: str, role: str | None = None) -> None:
    """注册中途失败时清理：只删 id 与本次生成值一致的账号（绝不误删同名的既有账号）。尽力而为，
    移出角色失败也照样删号。"""
    try:
        user = get_user_by_name(name)
    except Exception:
        log.exception("无法确认未完成注册的 IAM 账号，请在 IAM 中核对：%s", _member(name))
        return
    if not user or user.get("id") != subject:
        return
    if role:
        try:
            _set_role_member(role, name, present=False)
        except Exception:
            log.exception("未能把 %s 移出 IAM 角色 %s，请在 IAM 中核对", _member(name), role)
    try:
        _call("POST", "delete-user", json={"owner": settings.CASDOOR_ORG, "name": name})
    except Exception:
        log.exception("清理未完成注册的 IAM 账号失败，请在 IAM 中手动删除：%s", _member(name))


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
