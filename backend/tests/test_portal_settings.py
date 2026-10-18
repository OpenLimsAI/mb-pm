"""工作台「设置」：门户会话改用户名、AI 分析设置（权限、Origin、临时密码拦截、与项目管理共用同一份设置）。"""

import time
from uuid import uuid4

import pytest

from app.api.v1.portal import PORTAL_SESSION_COOKIE
from app.core import security
from app.core.config import settings
from app.db.session import SessionLocal
from app.models import IAMIdentity, PortalSession, User
from app.services import ai, iam_admin, password_policy
from app.services.iam_admin import IAMError

ORG = "mabpharm"
AI_URL = "/api/v1/portal/settings/ai"
USERNAME_URL = "/api/v1/portal/username"


@pytest.fixture(autouse=True)
def isolated_ai_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(tmp_path / "ai.json"))


def portal_headers(token_factory, sub, name, *roles, origin=True):
    """为指定账号建门户会话，返回请求头。"""
    sid = f"psid-{uuid4().hex}"
    token = token_factory(
        "rd",
        sub=sub,
        name=name,
        roles=[{"owner": ORG, "name": r, "isEnabled": True} for r in roles],
    )
    with SessionLocal() as db:
        db.add(
            PortalSession(
                id=security.digest(sid),
                expires_at=int(time.time()) + 600,
                tokens=security.seal({"access_token": token, "id_token": token}),
            )
        )
        db.commit()
    headers = {"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}"}
    if origin:
        headers["Origin"] = settings.portal_origin
    return headers


def member(name: str, sub: str | None) -> str:
    with SessionLocal() as db:
        user = User(
            id=f"u-{uuid4().hex[:10]}",
            username=name,
            display_name=name,
            email=f"{name}@example.com",
            role="rd",
            is_active=True,
        )
        db.add(user)
        db.flush()
        if sub:
            db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=sub, user_id=user.id))
        db.commit()
        return user.id


def uid(prefix: str) -> str:
    return f"{prefix}{uuid4().hex[:6]}"


def ai_payload():
    cfg = ai.public_settings(ai.load_settings())
    cfg["providers"]["deepseek"]["api_key"] = "test-secret-not-real"
    cfg["providers"]["deepseek"]["model"] = "deepseek-chat"
    return cfg


@pytest.fixture
def iam(monkeypatch):
    """IAM 账号的最小替身：sub → 用户名 / 密码 / 角色 / 停用状态（门户接口实时核对用到）。"""
    accounts: dict[str, dict] = {
        "t-admin": {
            "name": "t-admin",
            "roles": [{"owner": ORG, "name": "admin", "isEnabled": True}],
        }
    }

    def get_user_by_sub(subject):
        return accounts[subject]

    def verify_password(name, password):
        if not any(a["name"] == name and a["password"] == password for a in accounts.values()):
            raise IAMError("当前密码不正确")

    def rename_user(subject, new_name):
        accounts[subject]["name"] = new_name

    monkeypatch.setattr(iam_admin, "get_user_by_sub", get_user_by_sub)
    monkeypatch.setattr(iam_admin, "verify_password", verify_password)
    monkeypatch.setattr(iam_admin, "rename_user", rename_user)
    monkeypatch.setattr(iam_admin, "name_shared_across_orgs", lambda name: False)

    def add(name, *roles, password="Current-2026"):
        sub = uid("sub-")
        accounts[sub] = {
            "id": sub,
            "name": name,
            "password": password,
            "roles": [{"owner": ORG, "name": r, "isEnabled": True} for r in roles],
        }
        return sub

    add.accounts = accounts
    return add


def session_for(iam, token_factory, prefix, *roles):
    name = uid(prefix)
    sub = iam(name, *roles)
    return sub, portal_headers(token_factory, sub, name, *roles)


def test_ai_settings_only_for_admin_and_project_leads(client, token_factory, auth_headers, iam):
    _, admin = session_for(iam, token_factory, "adm", "admin")
    _, lead = session_for(iam, token_factory, "lead", "cmc_lead")
    _, old_lead = session_for(iam, token_factory, "pl", "project_lead")
    _, staff = session_for(iam, token_factory, "rd", "kb_editor")

    assert client.get("/api/v1/portal/me", headers=admin).json()["can_configure_ai"] is True
    assert client.get("/api/v1/portal/me", headers=lead).json()["can_configure_ai"] is True
    assert client.get("/api/v1/portal/me", headers=staff).json()["can_configure_ai"] is False
    for headers in (old_lead, staff):
        assert client.get(AI_URL, headers=headers).status_code == 403
        assert client.put(AI_URL, json=ai_payload(), headers=headers).status_code == 403
    assert client.get(AI_URL).status_code == 401

    # 写操作要求门户 Origin
    no_origin = {"Cookie": admin["Cookie"]}
    assert client.put(AI_URL, json=ai_payload(), headers=no_origin).status_code == 403

    res = client.put(AI_URL, json=ai_payload(), headers=lead)
    assert res.status_code == 200, res.text
    assert "test-secret-not-real" not in res.text  # 密钥不回显
    # 与项目管理读取的是同一份设置
    pm_view = client.get("/api/v1/ai/settings", headers=auth_headers).json()
    assert pm_view["providers"]["deepseek"]["model"] == "deepseek-chat"
    assert pm_view["providers"]["deepseek"]["key_set"] is True
    assert client.get(AI_URL, headers=admin).json() == pm_view


def test_ai_settings_follow_live_iam_status_and_roles(client, token_factory, iam):
    """登录令牌里仍是管理员，但 IAM 中已撤销角色或停用：立即拒绝。"""
    sub, admin = session_for(iam, token_factory, "adm", "admin")
    assert client.get(AI_URL, headers=admin).status_code == 200
    iam.accounts[sub]["roles"] = [{"owner": ORG, "name": "kb_editor", "isEnabled": True}]
    assert client.put(AI_URL, json=ai_payload(), headers=admin).status_code == 403
    iam.accounts[sub]["roles"] = [{"owner": ORG, "name": "admin", "isEnabled": True}]
    iam.accounts[sub]["isForbidden"] = True
    res = client.put(AI_URL, json=ai_payload(), headers=admin)
    assert res.status_code == 403 and "停用" in res.json()["detail"]


def test_ai_connection_errors_are_reported(client, token_factory, monkeypatch, iam):
    _, admin = session_for(iam, token_factory, "adm", "admin")

    def fail(*args, **kwargs):
        raise ai.AIError("模型服务不可用")

    monkeypatch.setattr(ai, "list_models", fail)
    monkeypatch.setattr(ai, "test_connection", fail)
    body = {"provider": "deepseek", "config": ai_payload()["providers"]["deepseek"]}
    for path in ("/models", "/test"):
        res = client.post(AI_URL + path, json=body, headers=admin)
        assert res.status_code == 502 and "模型服务不可用" in res.json()["detail"]


def test_username_change_updates_iam_and_member(client, token_factory, iam):
    name = uid("old")
    sub = iam(name)
    member_id = member(name, sub)
    headers = portal_headers(token_factory, sub, name, "kb_editor")
    new_name = uid("new")
    body = {"new_username": new_name, "current_password": "Current-2026"}

    assert (
        client.post(USERNAME_URL, json=body, headers={"Cookie": headers["Cookie"]}).status_code
        == 403
    )
    wrong = {**body, "current_password": "Wrong-pass-1"}
    assert client.post(USERNAME_URL, json=wrong, headers=headers).status_code == 400
    assert iam.accounts[sub]["name"] == name

    res = client.post(USERNAME_URL, json=body, headers=headers)
    assert res.status_code == 200, res.text
    assert res.json()["username"] == new_name
    assert iam.accounts[sub]["name"] == new_name
    with SessionLocal() as db:
        assert db.get(User, member_id).username == new_name
    # 登录令牌里还是旧用户名，门户显示以已同步的成员用户名为准
    assert client.get("/api/v1/portal/me", headers=headers).json()["user"]["username"] == new_name


def test_username_change_rejects_taken_names_and_flagged_accounts(client, token_factory, iam):
    taken = uid("taken")
    member(taken, None)  # 预置成员也占用用户名
    name = uid("me")
    sub = iam(name)
    headers = portal_headers(token_factory, sub, name)
    body = {"new_username": taken, "current_password": "Current-2026"}
    assert client.post(USERNAME_URL, json=body, headers=headers).status_code == 409
    same = {"new_username": name, "current_password": "Current-2026"}
    assert client.post(USERNAME_URL, json=same, headers=headers).status_code == 400

    # 还没进入过项目管理（无成员）也可以改名
    fresh = uid("fresh")
    res = client.post(
        USERNAME_URL,
        json={"new_username": fresh, "current_password": "Current-2026"},
        headers=headers,
    )
    assert res.status_code == 200 and iam.accounts[sub]["name"] == fresh
    # 登录令牌里仍是旧名：门户显示本会话记下的新用户名
    assert client.get("/api/v1/portal/me", headers=headers).json()["user"]["username"] == fresh

    # 管理员设置了临时密码：先改密码，其他设置一律 403
    with SessionLocal() as db:
        password_policy.require_change(db, sub, "reset")
        db.commit()
    again = {"new_username": uid("later"), "current_password": "Current-2026"}
    res = client.post(USERNAME_URL, json=again, headers=headers)
    assert res.status_code == 403 and "临时密码" in res.json()["detail"]
    with SessionLocal() as db:
        password_policy.clear_change(db, sub)
        db.commit()


def test_username_change_does_not_claim_case_variant_member(client, token_factory, iam):
    """未绑定的同名成员只在用户名完全相同时视为本人（与首次登录关联规则一致）。"""
    other = uid("zhang")
    other_id = member(other, None)
    sub = iam(other.upper())
    headers = portal_headers(token_factory, sub, other.upper())
    body = {"new_username": other, "current_password": "Current-2026"}
    res = client.post(USERNAME_URL, json=body, headers=headers)
    assert res.status_code == 409  # 大小写不同的成员属于他人：按已被占用拒绝
    with SessionLocal() as db:
        assert db.get(User, other_id).username == other
        assert db.query(IAMIdentity).filter_by(user_id=other_id).first() is None
