"""Casdoor 管理接口：本人改用户名 / 改密码，以及门户「账号管理」（仅后端调用）。

以应用的 client id / secret 调用 Casdoor —— 应用凭据在 Casdoor 中具备管理权限，
所以这里只提供少数几个固定操作，目标一律限定在本组织（CASDOOR_ORG）：
本人改名 / 改密的账号由调用方按当前登录用户的 IAM sub 定位，绝不接受浏览器传来的用户标识；
账号管理的操作由 services/accounts.py 先核对管理员身份与目标账号所属组织后再调用。

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


def list_users() -> list[dict]:
    """本组织全部账号。get-users 不带 roles，角色成员另由 list_roles() 取。"""
    users = _call("GET", "get-users", params={"owner": settings.CASDOOR_ORG}).get("data") or []
    return [u for u in users if isinstance(u, dict) and u.get("owner") == settings.CASDOOR_ORG]


def list_roles() -> list[dict]:
    roles = _call("GET", "get-roles", params={"owner": settings.CASDOOR_ORG}).get("data") or []
    return [r for r in roles if isinstance(r, dict) and r.get("owner") == settings.CASDOOR_ORG]


def create_user(name: str, display_name: str, password: str, email: str) -> dict:
    """建普通账号；Casdoor 负责密码哈希与组织的密码规则。返回新账号（含 sub）。

    needUpdatePassword 由 IAM 统一执行，其他应用直登同样必须先修改临时密码。
    """
    _call(
        "POST",
        "add-user",
        json={
            "owner": settings.CASDOOR_ORG,
            "name": name,
            "displayName": display_name,
            "password": password,
            "email": email,
            "type": "normal-user",
            "needUpdatePassword": True,
        },
    )
    user = get_user_by_name(name)
    if not user or not isinstance(user.get("id"), str) or not user["id"]:
        raise IAMError("IAM 未返回新账号，请刷新后核对")
    return user


def update_user(subject: str, name: str, fields: dict) -> None:
    """按 sub 只改指定字段（Casdoor 带 columns 时只更新这些列）。"""
    body = _call(
        "POST",
        "update-user",
        params={"owner": settings.CASDOOR_ORG, "userId": subject, "columns": ",".join(fields)},
        json={"owner": settings.CASDOOR_ORG, "name": name, **fields},
    )
    if body.get("data") != "Affected":
        raise IAMError("IAM 未能保存账号信息，请稍后重试")


def reset_password(name: str, new_password: str) -> None:
    """管理员重置密码：应用凭据调用且旧密码为空时 Casdoor 不校验旧密码，仍执行组织的密码规则。
    本人改密必须走 set_password（带当前密码），不能用这个函数。"""
    _call(
        "POST",
        "set-password",
        data={
            "userOwner": settings.CASDOOR_ORG,
            "userName": name,
            "oldPassword": "",
            "newPassword": new_password,
        },
    )


def set_role_members(
    role: str, add: set[str] = frozenset(), remove: set[str] = frozenset()
) -> bool:
    """在本组织角色中增删成员（成员写作 org/name）。Casdoor 按整条记录更新，须回传完整角色。"""
    data = _call("GET", "get-role", params={"id": _member(role)}).get("data")
    if not isinstance(data, dict) or data.get("owner") != settings.CASDOOR_ORG:
        raise IAMError(f"IAM 中没有角色 {role}")
    before = [str(m) for m in data.get("users") or []]
    drop = {_member(n) for n in remove}
    after = [m for m in before if m not in drop]
    after += [m for m in sorted(_member(n) for n in add) if m not in after]
    if after == before:
        return False
    _call("POST", "update-role", params={"id": _member(role)}, json={**data, "users": after})
    return True


def delete_user(name: str) -> None:
    """Casdoor 删除账号时不清理角色成员 —— 调用方须先把账号移出所有角色。"""
    _call("POST", "delete-user", json={"owner": settings.CASDOOR_ORG, "name": name})


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


def _authorization_records(account: dict, *, sessions: bool) -> list[dict]:
    """Only retain target user's non-secret identifiers from the IAM admin response.

    Casdoor v3.152.0 only applies field/value when pagination is specified. Its
    filter may return partial matches: recheck organization and exact username.
    """
    path = "get-sessions" if sessions else "get-tokens"
    records = []
    for page in range(1, 101):
        params = {
            "owner": settings.CASDOOR_ORG if sessions else "",
            "field": "name" if sessions else "user",
            "value": account["name"],
            "pageSize": "100",
            "p": str(page),
        }
        if not sessions:
            params["organization"] = settings.CASDOOR_ORG
        rows = _call("GET", path, params=params).get("data")
        if not isinstance(rows, list):
            raise IAMError("IAM 会话列表格式无效")
        for row in rows:
            if not isinstance(row, dict):
                raise IAMError("IAM 会话列表格式无效")
            if sessions:
                if row.get("owner") != account["owner"] or row.get("name") != account["name"]:
                    continue
                keys = ("owner", "name", "application")
            else:
                if (
                    row.get("organization") != account["owner"]
                    or row.get("user") != account["name"]
                ):
                    continue
                keys = ("owner", "name", "organization")
            if any(not isinstance(row.get(key), str) or not row[key] for key in keys):
                raise IAMError("IAM 会话标识无效")
            records.append({key: row[key] for key in keys})
        if len(rows) < 100:
            return records
    raise IAMError("IAM 会话数量超出安全处理范围，请联系管理员")


def check_revocation_available(account: dict) -> None:
    """Preflight before changing a password; no credentials are exposed or logged."""
    _authorization_records(account, sessions=True)
    _authorization_records(account, sessions=False)


def revoke_user_authorizations(subject: str) -> None:
    """Delete only this immutable subject's SSO sessions and access/refresh records.

    SSO is removed first to prevent silent reauthentication. A second enumeration
    also catches token rotations racing with cleanup. Non-convergence is an error.
    """
    account = get_user_by_sub(subject)
    for _ in range(3):
        sessions = _authorization_records(account, sessions=True)
        tokens = _authorization_records(account, sessions=False)
        if not sessions and not tokens:
            return
        for item in sessions:
            _call("POST", "delete-session", json=item)
        for item in tokens:
            _call("POST", "delete-token", json=item)
    if _authorization_records(account, sessions=True) or _authorization_records(
        account, sessions=False
    ):
        raise IAMError("IAM 仍存在登录授权，撤销尚未完成")
