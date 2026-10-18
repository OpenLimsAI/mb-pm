"""门户「账号管理」（IAM 的简化版）：用内存版 Casdoor 替身（按本地 Casdoor 3.100.0 实测的接口形状），不访问外部 IAM。

实测要点（2026-10-16）：add-user 哈希密码并生成 id；应用凭据 set-password 不校验旧密码；
update-user 带 columns 只改这些列；get-user 带 roles、get-users 不带；delete-user 不清理角色成员。
"""

import copy
import json
import time
from uuid import uuid4

import httpx
import pytest

from app.api.v1.portal import PORTAL_SESSION_COOKIE
from app.core import security
from app.core.config import settings
from app.db.session import SessionLocal
from app.models import (
    AuditLog,
    IAMIdentity,
    PasswordChangeRequired,
    PortalSession,
    User,
)
from app.services.members import PLACEHOLDER_EMAIL_DOMAIN

ORG = "mabpharm"
ROLE_NAMES = sorted(security.ROLES | {"kb_viewer", "kb_editor", "dikw-admin"})


class FakeCasdoor:
    def __init__(self):
        self.users: dict[str, dict] = {}
        self.roles = {
            name: {
                "owner": ORG,
                "name": name,
                "displayName": name,
                "description": "",
                "createdTime": "",
                "users": [],
                "groups": [],
                "roles": [],
                "domains": [],
                "isEnabled": True,
            }
            for name in ROLE_NAMES
        }
        self.calls: list[str] = []
        self.fail: dict[str, str | list[str]] = {}
        self.role_delay = 0
        self.silent_roles: set[str] = set()
        self.silent_user_updates: list[bool] = []

    def add(self, name, *roles, subject=None, display=None, **extra):
        subject = subject or f"sub-{uuid4().hex}"
        self.users[name] = {
            "owner": ORG,
            "id": subject,
            "name": name,
            "displayName": display or name,
            "email": "",
            "password": "Initial-pass1",
            "isForbidden": False,
            "isAdmin": False,
            "isDeleted": False,
            "needUpdatePassword": False,
            "createdTime": f"2026-10-16T00:00:{len(self.users):02d}+08:00",
            **extra,
        }
        for role in roles:
            self.roles[role]["users"].append(f"{ORG}/{name}")
        return subject

    def members(self, role):
        return [m.split("/", 1)[1] for m in self.roles[role]["users"]]

    def roles_of(self, name):
        return sorted(r for r, data in self.roles.items() if f"{ORG}/{name}" in data["users"])

    @staticmethod
    def ok(data=None):
        return httpx.Response(200, json={"status": "ok", "msg": "", "data": data})

    @staticmethod
    def error(msg):
        return httpx.Response(200, json={"status": "error", "msg": msg, "data": None})

    def request(self, method, url, *, params=None, json=None, data=None, auth=None, **kwargs):
        assert auth == (settings.CASDOOR_CLIENT_ID, settings.CASDOOR_CLIENT_SECRET)
        assert url.startswith(settings.casdoor_internal_url + "/api/")
        assert kwargs["trust_env"] is False
        path = url.split("/api/", 1)[1]
        self.calls.append(path)
        role = (params or {}).get("id", "").partition("/")[2]
        failure_key = f"{path}:{role}" if f"{path}:{role}" in self.fail else path
        failure = self.fail.get(failure_key)
        if isinstance(failure, list):
            failure = failure.pop(0) if failure else None
        if failure in {"error", "once"}:
            if failure == "once":
                self.fail.pop(failure_key)
            response = self.error("模拟 IAM 拒绝")
        else:
            response = getattr(self, "_" + path.replace("-", "_"))(params or {}, json, data)
        if path == "get-role" and self.role_delay:
            time.sleep(self.role_delay)
        response.request = httpx.Request(method, url)
        return response

    def _public(self, user, *, with_roles):
        out = {**user, "password": "***"}
        if with_roles:
            out["roles"] = [
                {"owner": ORG, "name": r, "isEnabled": self.roles[r]["isEnabled"]}
                for r in self.roles_of(user["name"])
            ]
        return out

    def _find(self, params):
        if params.get("userId"):
            assert params.get("owner") == ORG
            return next((u for u in self.users.values() if u["id"] == params["userId"]), None)
        owner, _, name = params["id"].partition("/")
        return self.users.get(name) if owner == ORG else None

    def _get_user(self, params, body, form):
        user = self._find(params)
        return self.ok(self._public(user, with_roles=True) if user else None)

    def _get_users(self, params, body, form):
        assert params["owner"] == ORG
        return self.ok([self._public(u, with_roles=False) for u in self.users.values()])

    def _get_roles(self, params, body, form):
        return self.ok(copy.deepcopy(list(self.roles.values())))

    def _get_role(self, params, body, form):
        return self.ok(copy.deepcopy(self.roles.get(params["id"].partition("/")[2])))

    def _update_role(self, params, body, form):
        owner, _, name = params["id"].partition("/")
        # Casdoor 按整条记录更新：必须回传完整角色
        assert body["owner"] == owner == ORG and body["name"] == name
        assert set(body) == set(self.roles[name])
        if name in self.silent_roles:
            return self.ok("Affected")
        self.roles[name] = copy.deepcopy(body)
        return self.ok("Affected")

    def _add_user(self, params, body, form):
        assert body["owner"] == ORG and body["type"] == "normal-user"
        # 不打开 Casdoor 的「需要更新密码」（会把人带到 IAM 自己的页面），首次改密由本系统完成
        assert "needUpdatePassword" not in body and "isAdmin" not in body
        if body["name"] in self.users:
            return self.error("用户名已存在")
        self.add(body["name"], display=body["displayName"], email=body["email"])
        self.users[body["name"]].update(password=body["password"])
        return self.ok("Affected")

    def _update_user(self, params, body, form):
        if self.silent_user_updates and self.silent_user_updates.pop(0):
            return self.ok("Affected")
        user = self._find(params)
        columns = params["columns"].split(",")
        assert body["owner"] == ORG and set(body) - {"owner", "name"} <= set(columns)
        if "name" in columns:
            if body["name"] in self.users:
                return self.error("用户名已存在")
            old = user["name"]
            del self.users[old]
            user["name"] = body["name"]
            self.users[user["name"]] = user
            for role in self.roles.values():  # Casdoor 改名同步改写角色成员
                role["users"] = [
                    f"{ORG}/{user['name']}" if m == f"{ORG}/{old}" else m for m in role["users"]
                ]
        for column in columns:
            if column != "name":
                user[column] = body[column]
        return self.ok("Affected")

    def _set_password(self, params, body, form):
        # 应用凭据 + 旧密码为空 = 管理员重置（不校验）；带旧密码 = 本人改密（校验旧密码）
        assert form["userOwner"] == ORG
        user = self.users[form["userName"]]
        if form["oldPassword"] and user["password"] != form["oldPassword"]:
            return self.error("密码或验证码错误")
        user["password"] = form["newPassword"]
        return self.ok()

    def _delete_user(self, params, body, form):
        assert body["owner"] == ORG
        self.users.pop(body["name"])  # 真实 Casdoor 不清理角色成员
        return self.ok("Affected")

    def _get_permissions(self, params, body, form):
        return self.ok([])


@pytest.fixture
def casdoor(client, token_factory, monkeypatch):
    fake = FakeCasdoor()
    monkeypatch.setattr(httpx, "request", fake.request)
    return fake


def uid(prefix="acct"):
    return f"{prefix}.{uuid4().hex[:8]}"


def pm_member(username, *, bind_to=None, active=True, role="rd"):
    db = SessionLocal()
    try:
        user = User(
            id=f"u-{uuid4().hex[:10]}",
            username=username,
            display_name=username,
            email=f"{username}@example.com",
            role=role,
            is_active=active,
        )
        db.add(user)
        db.flush()
        if bind_to:
            db.add(IAMIdentity(issuer=settings.casdoor_issuer, subject=bind_to, user_id=user.id))
        db.commit()
        return user.id
    finally:
        db.close()


def fetch(model, **filters):
    db = SessionLocal()
    try:
        return db.query(model).filter_by(**filters).first()
    finally:
        db.close()


@pytest.fixture
def admin(casdoor, token_factory):
    """IAM 管理员 + 已绑定的项目管理成员 + 门户会话：返回 (sub, 用户名, 请求头)。"""

    def make(*roles, iam_roles=("admin",)):
        name = uid("admin")
        sub = casdoor.add(name, *iam_roles)
        pm_member(name, bind_to=sub, role="admin")
        sid = f"psid-{uuid4().hex}"
        token = token_factory(
            "admin",
            sub=sub,
            name=name,
            roles=[{"owner": ORG, "name": r, "isEnabled": True} for r in roles or ("admin",)],
        )
        db = SessionLocal()
        try:
            db.add(
                PortalSession(
                    id=security.digest(sid),
                    expires_at=int(time.time()) + 600,
                    tokens=security.seal({"access_token": token, "id_token": token}),
                )
            )
            db.commit()
        finally:
            db.close()
        headers = {"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}", "Origin": settings.portal_origin}
        return sub, name, headers

    return make


URL = "/api/v1/portal/accounts"


def flagged(subject):
    return (
        fetch(PasswordChangeRequired, issuer=settings.casdoor_issuer, subject=subject) is not None
    )


def open_portal_session(token_factory, sub, name, roles=()):
    """为指定账号建门户会话（令牌经真实 RSA 验签），返回会话 cookie 值。"""
    sid = f"psid-{uuid4().hex}"
    token = token_factory(
        "rd",
        sub=sub,
        name=name,
        roles=[{"owner": ORG, "name": r, "isEnabled": True} for r in roles],
    )
    db = SessionLocal()
    try:
        db.add(
            PortalSession(
                id=security.digest(sid),
                expires_at=int(time.time()) + 600,
                tokens=security.seal({"access_token": token, "id_token": token}),
            )
        )
        db.commit()
    finally:
        db.close()
    return sid


def listing(client, headers):
    response = client.get(URL, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    return {a["username"]: a for a in body["accounts"]}, body["issues"]


def new_account(**overrides):
    identity = overrides.pop("identity", "staff")
    return {
        "username": uid("new"),
        "display_name": "新同事",
        "password": "Welcome-2026",
        "platform_admin": identity == "admin",
        "pm_identity": "staff" if identity == "admin" else identity,
        "kb_role": "editor",
        "specialty_group": "上游",
        "weekly_hours": 36,
        **overrides,
    }


def test_account_lists_platform_identity_and_app_roles_separately(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("platform")
    casdoor.add(name, "admin", "cmc_lead", "kb_viewer", "dikw-admin")

    accounts, _ = listing(client, headers)
    account = accounts[name]
    assert account["platform_admin"] is True
    assert account["pm_identity"] == "lead"
    assert account["pm_effective_role"] == "admin"
    assert account["pm_roles"] == ["cmc_lead"]
    assert account["kb_role"] == "viewer"
    assert account["kb_roles"] == ["kb_viewer"]
    assert account["other_roles"] == ["dikw-admin"]


def test_platform_admin_toggle_preserves_business_and_knowledge_roles(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("separate")
    sub = casdoor.add(name, "cmc_lead", "kb_viewer", "dikw-admin")
    url = f"{URL}/{sub}"
    assert client.patch(url, json={"platform_admin": True}, headers=headers).status_code == 204
    accounts, _ = listing(client, headers)
    assert accounts[name]["platform_admin"] is True
    assert accounts[name]["pm_identity"] == "lead"
    assert accounts[name]["pm_effective_role"] == "admin"
    assert accounts[name]["kb_role"] == "viewer"
    assert accounts[name]["other_roles"] == ["dikw-admin"]

    assert client.patch(url, json={"platform_admin": False}, headers=headers).status_code == 204
    accounts, _ = listing(client, headers)
    assert accounts[name]["platform_admin"] is False
    assert accounts[name]["pm_effective_role"] == "cmc_lead"
    assert accounts[name]["kb_role"] == "viewer"


def test_pm_business_role_changes_do_not_remove_platform_admin(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("business")
    sub = casdoor.add(name, "admin", "cmc_lead", "kb_editor", "dikw-admin")
    assert (
        client.patch(f"{URL}/{sub}", json={"pm_identity": "staff"}, headers=headers).status_code
        == 204
    )
    accounts, _ = listing(client, headers)
    assert accounts[name]["platform_admin"] is True
    assert accounts[name]["pm_identity"] == "staff"
    assert accounts[name]["pm_effective_role"] == "admin"
    assert accounts[name]["kb_role"] == "editor"
    assert accounts[name]["other_roles"] == ["dikw-admin"]


def test_knowledge_viewer_cannot_be_written(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("kbcontract")
    sub = casdoor.add(name, "kb_editor")
    response = client.patch(f"{URL}/{sub}", json={"kb_role": "viewer"}, headers=headers)
    assert response.status_code == 422
    accounts, _ = listing(client, headers)
    assert accounts[name]["kb_role"] == "editor"
    assert accounts[name]["pm_member"] is None


def test_explicit_knowledge_upgrade_does_not_create_pm_member(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("kbonly")
    sub = casdoor.add(name, "kb_viewer", "dikw-admin")
    assert (
        client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers).status_code == 204
    )
    accounts, _ = listing(client, headers)
    assert accounts[name]["kb_role"] == "editor"
    assert accounts[name]["kb_roles"] == ["kb_editor"]
    assert accounts[name]["pm_member"] is None
    assert accounts[name]["other_roles"] == ["dikw-admin"]


def test_create_uses_separate_platform_and_business_roles(client, casdoor, admin):
    _, _, headers = admin()
    body = new_account()
    body.update(platform_admin=True, pm_identity="lead", kb_role="editor")
    assert client.post(URL, json=body, headers=headers).status_code == 204
    accounts, _ = listing(client, headers)
    account = accounts[body["username"]]
    assert account["platform_admin"] is True
    assert account["pm_identity"] == "lead"
    assert account["pm_effective_role"] == "admin"
    assert account["kb_role"] == "editor"


def test_disabled_editor_role_is_rejected_before_any_update(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("disabledrole")
    sub = casdoor.add(name, "kb_viewer")
    casdoor.roles["kb_editor"]["isEnabled"] = False
    response = client.patch(
        f"{URL}/{sub}", json={"kb_role": "editor", "display_name": "不能保存"}, headers=headers
    )
    assert response.status_code == 409
    accounts, _ = listing(client, headers)
    assert accounts[name]["display_name"] == name
    assert accounts[name]["kb_role"] == "viewer"
    assert accounts[name]["pm_member"] is None


def test_partial_iam_failure_restores_roles_and_profile(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("rollback")
    sub = casdoor.add(name, "kb_viewer", "dikw-admin")
    casdoor.fail["update-role:kb_viewer"] = "once"
    response = client.patch(
        f"{URL}/{sub}", json={"kb_role": "editor", "display_name": "新姓名"}, headers=headers
    )
    assert response.status_code == 400
    accounts, _ = listing(client, headers)
    assert accounts[name]["display_name"] == name
    assert accounts[name]["kb_roles"] == ["kb_viewer"]
    assert accounts[name]["other_roles"] == ["dikw-admin"]


def test_concurrent_updates_preserve_both_accounts_role_membership(client, casdoor, admin):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    _, _, headers = admin()
    names = [uid("concurrent"), uid("concurrent")]
    subjects = [casdoor.add(name, "kb_viewer") for name in names]
    ready = Barrier(2)
    casdoor.role_delay = 0.1

    def save(subject):
        ready.wait(timeout=5)
        return client.patch(f"{URL}/{subject}", json={"kb_role": "editor"}, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, subjects))
    assert [response.status_code for response in responses] == [204, 204]
    accounts, _ = listing(client, headers)
    assert [accounts[name]["kb_role"] for name in names] == ["editor", "editor"]


def test_database_failure_rolls_back_iam_changes(client, casdoor, admin):
    from sqlalchemy import event
    from sqlalchemy.exc import SQLAlchemyError
    from app.db.session import engine

    _, _, headers = admin()
    name = uid("dbfailure")
    sub = casdoor.add(name, "kb_viewer")

    def reject_audit(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO audit_logs"):
            raise SQLAlchemyError("模拟数据库写入失败")

    event.listen(engine, "before_cursor_execute", reject_audit)
    try:
        response = client.patch(
            f"{URL}/{sub}", json={"kb_role": "editor", "display_name": "新姓名"}, headers=headers
        )
    finally:
        event.remove(engine, "before_cursor_execute", reject_audit)
    assert response.status_code == 409
    accounts, _ = listing(client, headers)
    assert accounts[name]["kb_role"] == "viewer"
    assert accounts[name]["display_name"] == name


def test_portal_catalogue_refreshes_after_explicit_kb_grant(client, casdoor, admin, token_factory):
    _, _, headers = admin()
    name = uid("catalogue")
    sub = casdoor.add(name)
    sid = open_portal_session(token_factory, sub, name)
    own = {"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}"}
    before = client.get("/api/v1/portal/me", headers=own).json()
    assert next(a for a in before["applications"] if a["id"] == "kb")["enabled"] is False
    assert (
        client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers).status_code == 204
    )
    after = client.get("/api/v1/portal/me", headers=own).json()
    assert next(a for a in after["applications"] if a["id"] == "kb")["enabled"] is True


def test_role_readback_rejects_silent_iam_write_failure(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("silent")
    sub = casdoor.add(name, "kb_viewer")
    casdoor.silent_roles.add("kb_editor")
    response = client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers)
    assert response.status_code == 409
    accounts, _ = listing(client, headers)
    assert accounts[name]["kb_roles"] == ["kb_viewer"]


def test_new_account_is_removed_if_role_readback_fails(client, casdoor, admin):
    _, _, headers = admin()
    body = new_account()
    casdoor.silent_roles.add("kb_editor")
    response = client.post(URL, json=body, headers=headers)
    assert response.status_code == 409
    accounts, _ = listing(client, headers)
    assert body["username"] not in accounts


@pytest.mark.parametrize(
    "payload",
    [
        {"identity": "admin"},
        {"roles": ["admin"]},
        {"pm_identity": "admin"},
        {"kb_role": "unassigned"},
        {"platform_admin": "false"},
        {"kb_role": "viewer"},
    ],
)
def test_unsafe_or_legacy_permission_writes_are_rejected(client, casdoor, admin, payload):
    _, _, headers = admin()
    name = uid("contract")
    sub = casdoor.add(name, "kb_viewer")
    assert client.patch(f"{URL}/{sub}", json=payload, headers=headers).status_code == 422
    accounts, _ = listing(client, headers)
    assert accounts[name]["platform_admin"] is False
    assert accounts[name]["kb_roles"] == ["kb_viewer"]


@pytest.mark.parametrize(
    "roles",
    [
        ("kb_viewer",),
        (),
        ("project_lead", "kb_viewer"),
        ("production", "kb_editor"),
        ("qa_qc", "kb_editor"),
    ],
)
def test_profile_and_noop_updates_preserve_roles_and_lazy_members(client, casdoor, admin, roles):
    _, _, headers = admin()
    name = uid("profile")
    sub = casdoor.add(name, *roles)
    url = f"{URL}/{sub}"
    assert (
        client.patch(
            url, json={"display_name": "新姓名", "email": "new@example.com"}, headers=headers
        ).status_code
        == 204
    )
    assert (
        client.patch(url, json={"email": None, "kb_role": None}, headers=headers).status_code == 204
    )
    accounts, _ = listing(client, headers)
    row = accounts[name]
    assert row["display_name"] == "新姓名" and row["email"] == "new@example.com"
    assert row["pm_roles"] == sorted(set(roles) & security.ROLES)
    assert row["pm_member"] is None


def test_knowledge_normalization_preserves_legacy_business_scope(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("mixed")
    sub = casdoor.add(name, "project_lead", "kb_viewer", "kb_editor")
    assert (
        client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers).status_code == 204
    )
    accounts, _ = listing(client, headers)
    assert accounts[name]["pm_effective_role"] == "project_lead"
    assert accounts[name]["kb_roles"] == ["kb_editor"]


def test_conflicting_pm_member_is_rejected_before_iam_changes(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("conflict")
    sub = casdoor.add(name, "kb_viewer")
    pm_member(name, bind_to="other-" + uuid4().hex)
    response = client.patch(
        f"{URL}/{sub}", json={"specialty_group": "分析", "display_name": "冲突"}, headers=headers
    )
    assert response.status_code == 409
    accounts, _ = listing(client, headers)
    assert accounts[name]["display_name"] == name


def test_platform_admin_still_requires_an_audit_member(client, casdoor, token_factory):
    name = uid("noaudit")
    sub = casdoor.add(name, "admin")
    sid = open_portal_session(token_factory, sub, name, roles=("admin",))
    response = client.get(URL, headers={"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}"})
    assert response.status_code == 403
    assert "记录操作人" in response.json()["detail"]


def test_empty_display_name_is_rejected(client, casdoor, admin):
    _, _, headers = admin()
    sub = casdoor.add(uid("empty"), "kb_editor")
    assert (
        client.patch(f"{URL}/{sub}", json={"display_name": "   "}, headers=headers).status_code
        == 422
    )
    assert (
        client.post(URL, json=new_account(display_name="   "), headers=headers).status_code == 422
    )


def test_inactive_account_cannot_be_repaired(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("inactivefix")
    sub = casdoor.add(name, "kb_editor", isForbidden=True)
    assert client.post(f"{URL}/{sub}/repair", headers=headers).status_code == 409
    accounts, _ = listing(client, headers)
    assert accounts[name]["enabled"] is False


@pytest.mark.parametrize(
    ("operation", "failure"),
    [
        ("username", "update-user"),
        ("password", "set-password"),
        ("repair", "update-user"),
        ("delete", "delete-user"),
    ],
)
def test_iam_rejections_on_sensitive_operations_are_not_success(
    client, casdoor, admin, operation, failure
):
    _, _, headers = admin()
    name = uid("rejected")
    sub = casdoor.add(name, "kb_editor", needUpdatePassword=operation == "repair")
    casdoor.fail[failure] = "error"
    url = f"{URL}/{sub}"
    if operation == "delete":
        response = client.delete(url, headers=headers)
    else:
        body = (
            {"username": uid("renamed")}
            if operation == "username"
            else {"password": "Another-pass2026"}
            if operation == "password"
            else None
        )
        response = client.post(f"{url}/{operation}", json=body, headers=headers)
    assert response.status_code == 400
    assert "模拟 IAM 拒绝" in response.json()["detail"]


def test_new_account_rejected_by_iam_does_not_persist(client, casdoor, admin):
    _, _, headers = admin()
    body = new_account()
    casdoor.fail["add-user"] = "error"
    assert client.post(URL, json=body, headers=headers).status_code == 400
    accounts, _ = listing(client, headers)
    assert body["username"] not in accounts


def test_username_conflicts_and_no_change_are_reported(client, casdoor, admin):
    _, _, headers = admin()
    name, taken = uid("rename"), uid("taken")
    sub = casdoor.add(name, "kb_editor")
    casdoor.add(taken)
    for username, status in [(name, 400), (taken, 409)]:
        assert (
            client.post(
                f"{URL}/{sub}/username", json={"username": username}, headers=headers
            ).status_code
            == status
        )


def test_failed_compensation_reports_possible_partial_changes(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("partial")
    sub = casdoor.add(name, "kb_viewer")
    casdoor.fail["update-role:kb_editor"] = ["ok", "error"]
    casdoor.fail["update-role:kb_viewer"] = "once"
    response = client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers)
    assert response.status_code == 409
    assert "自动撤销失败" in response.json()["detail"]
    accounts, _ = listing(client, headers)
    assert accounts[name]["kb_roles"] == ["kb_editor", "kb_viewer"]


def test_unreadable_unrelated_session_does_not_prevent_role_grant(
    client, casdoor, admin, token_factory
):
    _, _, headers = admin()
    name = uid("badcache")
    sub = casdoor.add(name)
    sid = open_portal_session(token_factory, sub, name)
    with SessionLocal() as db:
        db.add(
            PortalSession(
                id=uuid4().hex, tokens="corrupt-test-session", expires_at=int(time.time()) + 60
            )
        )
        db.commit()
    assert (
        client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers).status_code == 204
    )
    response = client.get("/api/v1/portal/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}"})
    assert next(a for a in response.json()["applications"] if a["id"] == "kb")["enabled"] is True


def test_profile_compensation_is_also_verified(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("silentundo")
    sub = casdoor.add(name, "kb_viewer")
    casdoor.silent_user_updates = [False, True]
    casdoor.fail["update-role:kb_viewer"] = "once"
    response = client.patch(
        f"{URL}/{sub}", json={"display_name": "新姓名", "kb_role": "editor"}, headers=headers
    )
    assert response.status_code == 409
    assert "自动撤销失败" in response.json()["detail"]


def test_local_read_failure_after_iam_write_also_compensates(client, casdoor, admin):
    from sqlalchemy import event
    from sqlalchemy.exc import SQLAlchemyError
    from app.db.session import engine

    _, _, headers = admin()
    name = uid("readfailure")
    sub = casdoor.add(name, "kb_viewer")

    def reject_catalogue(conn, cursor, statement, parameters, context, executemany):
        if "FROM portal_sessions" in statement and "kb_editor" in casdoor.roles_of(name):
            raise SQLAlchemyError("模拟入口缓存查询失败")

    event.listen(engine, "before_cursor_execute", reject_catalogue)
    try:
        response = client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", reject_catalogue)
    assert response.status_code == 409
    accounts, _ = listing(client, headers)
    assert accounts[name]["kb_role"] == "viewer"


@pytest.fixture
def lead(admin):
    """项目负责人（cmc_lead）的门户会话。"""
    return lambda: admin("cmc_lead", iam_roles=("cmc_lead",))


# —— 准入 —— #


def test_only_admins_and_leads_may_use_account_management(client, casdoor, admin, lead):
    assert client.get(URL).status_code == 401
    sub, name, headers = admin()
    assert client.get(URL, headers=headers).json()["actor"] == "admin"
    _, _, lead_headers = lead()
    assert client.get(URL, headers=lead_headers).json()["actor"] == "lead"
    _, _, staff_headers = admin("kb_editor", iam_roles=("kb_editor",))
    assert client.get(URL, headers=staff_headers).status_code == 403
    # 令牌里仍写着 admin，但 IAM 中已被移出：实时核对后拒绝
    casdoor.roles["admin"]["users"].remove(f"{ORG}/{name}")
    assert client.get(URL, headers=headers).status_code == 403
    casdoor.roles["admin"]["users"].append(f"{ORG}/{name}")
    casdoor.users[name]["isForbidden"] = True
    assert client.get(URL, headers=headers).status_code == 403


def test_writes_require_portal_origin(client, casdoor, admin):
    _, _, headers = admin()
    for bad in ({}, {"Origin": "http://evil.test"}):
        response = client.post(
            URL, json=new_account(), headers={"Cookie": headers["Cookie"], **bad}
        )
        assert response.status_code == 403
    assert [c for c in casdoor.calls if c == "add-user"] == []


def test_portal_catalogue_shows_accounts_entry_to_admins_and_leads(client, casdoor, admin):
    def apps(*roles):
        _, _, headers = admin(*roles)
        body = client.get("/api/v1/portal/me", headers=headers).json()
        return {a["id"]: a for a in body["applications"]}

    assert apps("admin")["accounts"]["enabled"] is True
    assert apps("cmc_lead")["accounts"]["enabled"] is True
    assert apps("project_lead")["accounts"]["enabled"] is True
    assert apps("rd", "kb_editor")["accounts"]["enabled"] is False
    assert apps("kb_editor")["accounts"]["enabled"] is False


def test_pm_member_writes_are_retired(client, auth_headers):
    """项目管理里不能再自行增删改成员：只保留账号管理一处。"""
    body = {"username": "x", "display_name": "x", "email": "x@example.com", "role": "rd"}
    assert client.post("/api/v1/users", json=body, headers=auth_headers).status_code == 410
    assert client.patch("/api/v1/users/any", json={}, headers=auth_headers).status_code == 410
    assert client.delete("/api/v1/users/any", headers=auth_headers).status_code == 410
    assert client.get("/api/v1/users", headers=auth_headers).status_code == 200


# —— 列表与一致性检查 —— #


def test_listing_maps_identity_kb_and_member_profile(client, casdoor, admin):
    _, actor_name, headers = admin()
    cases = {
        "lead": (("cmc_lead", "kb_editor", "dikw-admin"), "lead", True),
        "oldlead": (("project_lead", "kb_viewer"), "lead", True),
        "staff": (("rd", "kb_editor"), "staff", True),
        "plain": (("kb_editor",), "staff", True),
        "nokb": ((), "staff", False),
        "boss": (("admin", "kb_editor"), "admin", True),
    }
    names = {}
    for key, (roles, _, _) in cases.items():
        names[key] = uid(key)
        casdoor.add(names[key], *roles)
    member_id = pm_member(names["staff"], bind_to=casdoor.users[names["staff"]]["id"])
    db = SessionLocal()
    try:
        member = db.get(User, member_id)
        member.specialty_group, member.weekly_available_hours = "分析", 32
        db.commit()
    finally:
        db.close()

    accounts, _ = listing(client, headers)
    for key, (_, identity, kb) in cases.items():
        a = accounts[names[key]]
        assert (a["identity"], a["kb_enabled"]) == (identity, kb), key
    assert accounts[names["lead"]]["other_roles"] == ["dikw-admin"]
    staff = accounts[names["staff"]]["pm_member"]
    assert (staff["specialty_group"], staff["weekly_hours"], staff["bound"]) == ("分析", 32, True)
    assert accounts[names["plain"]]["pm_member"] is None  # 首次进入项目管理时自动建
    assert accounts[actor_name]["identity"] == "admin" and accounts[actor_name]["is_self"] is True


def test_issues_are_listed_for_admins_only(client, casdoor, admin, lead):
    _, _, headers = admin()
    nokb = uid("nokb")
    casdoor.add(nokb, "rd")
    inactive = uid("inactive")
    inactive_sub = casdoor.add(inactive, "kb_editor")
    pm_member(inactive, bind_to=inactive_sub, active=False)
    clash = uid("clash")
    casdoor.add(clash, "kb_editor")
    pm_member(clash, bind_to=f"other-{uuid4().hex}")
    leftover = "user_" + uuid4().hex[:6]
    casdoor.add(leftover, display="New User - " + leftover[5:])
    orphan = uid("orphan")
    pm_member(orphan)
    fine = uid("fine")
    casdoor.add(fine, "kb_editor")  # 没有成员不算问题：首次进入项目管理时自动建

    _, issues = listing(client, headers)
    kinds = {(i["kind"], i["username"]) for i in issues}
    assert ("kb_missing", nokb) in kinds
    assert ("pm_member_inactive", inactive) in kinds
    assert ("pm_member_conflict", clash) in kinds
    assert ("default_account", leftover) in kinds
    assert ("pm_only_member", orphan) in kinds
    assert not [k for k in kinds if k[1] == fine]
    _, _, lead_headers = lead()
    assert listing(client, lead_headers)[1] == []


# —— 新建 —— #


@pytest.mark.parametrize(
    ("identity", "iam_roles", "member_role"),
    [
        ("admin", ["admin", "kb_editor"], "admin"),
        ("lead", ["cmc_lead", "kb_editor"], "cmc_lead"),
        ("staff", ["kb_editor"], "rd"),
    ],
)
def test_create_maps_identity_and_opens_both_apps(
    client, casdoor, admin, identity, iam_roles, member_role
):
    _, _, headers = admin()
    body = new_account(identity=identity)
    assert client.post(URL, json=body, headers=headers).status_code == 204
    name = body["username"]
    user = casdoor.users[name]
    assert user["password"] == "Welcome-2026" and user["needUpdatePassword"] is False
    assert flagged(user["id"])  # 首次登录须在工作台内改密
    assert casdoor.roles_of(name) == iam_roles
    member = fetch(User, username=name)
    assert member.role == member_role and member.is_active
    assert (member.specialty_group, member.weekly_available_hours) == ("上游", 36)
    assert member.email == f"{name}@{PLACEHOLDER_EMAIL_DOMAIN}"
    identity_row = fetch(IAMIdentity, issuer=settings.casdoor_issuer, subject=user["id"])
    assert identity_row.user_id == member.id
    log = fetch(AuditLog, action="新建账号", target_id=user["id"][:40])
    assert "Welcome-2026" not in log.detail and json.loads(log.detail)["identity"] == identity


def test_create_links_preprovisioned_member(client, casdoor, admin):
    _, _, headers = admin()
    body = new_account(identity="lead")
    existing = pm_member(body["username"], active=False)
    assert client.post(URL, json=body, headers=headers).status_code == 204
    member = fetch(User, id=existing)
    assert member.is_active and member.role == "cmc_lead" and member.specialty_group == "上游"
    sub = casdoor.users[body["username"]]["id"]
    assert fetch(IAMIdentity, issuer=settings.casdoor_issuer, subject=sub).user_id == existing


def test_create_rejects_conflicts_and_bad_input(client, casdoor, admin):
    _, _, headers = admin()
    taken = uid("taken")
    casdoor.add(taken)
    assert client.post(URL, json=new_account(username=taken), headers=headers).status_code == 409
    bound = uid("bound")
    pm_member(bound, bind_to=f"other-{uuid4().hex}")
    assert client.post(URL, json=new_account(username=bound), headers=headers).status_code == 409
    for bad in (
        {"password": "short1"},
        {"username": "Bad Name"},
        {"username": "admin"},
        {"identity": "owner"},
        {"specialty_group": "财务"},
        {"weekly_hours": 100},
    ):
        assert client.post(URL, json=new_account(**bad), headers=headers).status_code == 422
    assert "add-user" not in casdoor.calls


def test_create_is_undone_when_iam_rejects_roles(client, casdoor, admin):
    _, _, headers = admin()
    body = new_account()
    casdoor.fail["update-role"] = "error"
    response = client.post(URL, json=body, headers=headers)
    assert response.status_code == 400 and "模拟 IAM 拒绝" in response.json()["detail"]
    assert body["username"] not in casdoor.users
    assert fetch(User, username=body["username"]) is None


def test_missing_iam_role_is_rejected_before_anything_is_created(client, casdoor, admin):
    _, _, headers = admin()
    del casdoor.roles["kb_editor"]  # 如本地测试 IAM 只建了项目管理角色
    assert "kb_editor" not in client.get(URL, headers=headers).json()["roles"]
    body = new_account()
    response = client.post(URL, json=body, headers=headers)
    assert response.status_code == 409 and "kb_editor" in response.json()["detail"]
    assert "add-user" not in casdoor.calls and body["username"] not in casdoor.users


def test_undo_keeps_going_when_one_role_cannot_be_cleared(client, casdoor, admin, monkeypatch):
    from fastapi import HTTPException

    from app.services import accounts as service
    from app.services import iam_admin

    _, _, headers = admin()
    real = iam_admin.set_role_members

    def flaky(role, add=frozenset(), remove=frozenset()):
        if remove and role == "kb_editor":
            raise iam_admin.IAMError("模拟移出失败")
        return real(role, add=add, remove=remove)

    def broken_member(*args, **kwargs):
        raise HTTPException(409, "模拟成员冲突")

    monkeypatch.setattr(iam_admin, "set_role_members", flaky)
    monkeypatch.setattr(service, "_ensure_member", broken_member)
    body = new_account(identity="lead")
    assert client.post(URL, json=body, headers=headers).status_code == 409
    assert body["username"] not in casdoor.users  # 账号仍被删除
    assert body["username"] not in casdoor.members("cmc_lead")


# —— 修改（仅系统管理员）—— #


def test_admin_changes_identity_profile_and_state(client, casdoor, admin, token_factory):
    _, _, headers = admin()
    name = uid("edit")
    sub = casdoor.add(name, "rd", "kb_editor", "dikw-admin")
    member_id = pm_member(name, bind_to=sub)
    url = f"{URL}/{sub}"

    body = {
        "display_name": "邓爱鹏",
        "pm_identity": "lead",
        "specialty_group": "制剂",
        "weekly_hours": 30,
    }
    assert client.patch(url, json=body, headers=headers).status_code == 204
    assert casdoor.roles_of(name) == ["cmc_lead", "dikw-admin", "kb_editor"]
    member = fetch(User, id=member_id)
    assert (member.display_name, member.role) == ("邓爱鹏", "cmc_lead")
    assert (member.specialty_group, member.weekly_available_hours) == ("制剂", 30)

    # 改回员工：不分配项目管理角色（登录时默认 rd）；管理工作台角色不受影响
    assert (
        client.patch(
            url, json={"pm_identity": "staff", "specialty_group": ""}, headers=headers
        ).status_code
        == 204
    )
    assert casdoor.roles_of(name) == ["dikw-admin", "kb_editor"]
    member = fetch(User, id=member_id)
    assert member.role == "rd" and member.specialty_group is None

    # 停用立即生效：对方的门户会话（按登录时令牌鉴权）一并结束
    sid = open_portal_session(token_factory, casdoor.users[name]["id"], name, roles=("kb_editor",))
    assert (
        client.get(
            "/api/v1/portal/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}"}
        ).status_code
        == 200
    )
    assert client.patch(url, json={"enabled": False}, headers=headers).status_code == 204
    assert casdoor.users[name]["isForbidden"] is True and not fetch(User, id=member_id).is_active
    assert fetch(PortalSession, id=security.digest(sid)) is None
    assert (
        client.get(
            "/api/v1/portal/me", headers={"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}"}
        ).status_code
        == 401
    )
    assert client.patch(url, json={"enabled": True}, headers=headers).status_code == 204
    assert casdoor.users[name]["isForbidden"] is False and fetch(User, id=member_id).is_active


def test_unchanged_identity_keeps_legacy_role(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("legacy")
    sub = casdoor.add(name, "qa_qc", "kb_editor")
    pm_member(name, bind_to=sub, role="qa_qc")
    calls = len(casdoor.calls)
    payload = {"pm_identity": "staff", "weekly_hours": 20}
    assert client.patch(f"{URL}/{sub}", json=payload, headers=headers).status_code == 204
    assert casdoor.roles_of(name) == ["kb_editor", "qa_qc"]
    assert "update-role" not in casdoor.calls[calls:]
    assert fetch(User, username=name).weekly_available_hours == 20


def test_editing_account_without_member_creates_one(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("fresh")
    sub = casdoor.add(name, "kb_editor", display="徐进")
    assert (
        client.patch(f"{URL}/{sub}", json={"specialty_group": "分析"}, headers=headers).status_code
        == 204
    )
    member = fetch(User, username=name)
    assert (member.display_name, member.role, member.specialty_group) == ("徐进", "rd", "分析")
    assert fetch(IAMIdentity, issuer=settings.casdoor_issuer, subject=sub).user_id == member.id


def test_leads_can_only_view(client, casdoor, admin, lead):
    _, _, headers = lead()
    staff = uid("staff")
    staff_sub = casdoor.add(staff, "kb_editor")
    url = f"{URL}/{staff_sub}"
    for body in ({"pm_identity": "lead"}, {"specialty_group": "分析"}, {"display_name": "x"}):
        assert client.patch(url, json=body, headers=headers).status_code == 403
    assert client.post(URL, json=new_account(), headers=headers).status_code == 403
    response = client.post(f"{url}/password", json={"password": "Another-2026"}, headers=headers)
    assert response.status_code == 403
    response = client.post(f"{url}/username", json={"username": uid("x")}, headers=headers)
    assert response.status_code == 403
    assert client.post(f"{url}/repair", headers=headers).status_code == 403
    assert client.delete(url, headers=headers).status_code == 403
    assert casdoor.roles_of(staff) == ["kb_editor"] and staff in casdoor.users


def test_admins_cannot_lock_themselves_or_org_admins_out(client, casdoor, admin):
    sub, name, headers = admin()
    own = f"{URL}/{sub}"
    assert client.patch(own, json={"platform_admin": False}, headers=headers).status_code == 409
    assert client.patch(own, json={"enabled": False}, headers=headers).status_code == 409
    assert client.delete(own, headers=headers).status_code == 409
    response = client.post(f"{own}/password", json={"password": "Another-2026"}, headers=headers)
    assert response.status_code == 409
    assert casdoor.roles_of(name) == ["admin"]

    org_admin = uid("orgadmin")
    org_sub = casdoor.add(org_admin, "admin", isAdmin=True)
    target = f"{URL}/{org_sub}"
    assert client.patch(target, json={"enabled": False}, headers=headers).status_code == 409
    assert client.delete(target, headers=headers).status_code == 409
    rename = client.post(f"{target}/username", json={"username": uid("x")}, headers=headers)
    assert rename.status_code == 409
    reset = client.post(f"{target}/password", json={"password": "Another-2026"}, headers=headers)
    assert reset.status_code == 409
    assert org_admin in casdoor.users and not casdoor.users[org_admin]["isForbidden"]


def test_rename_syncs_iam_roles_and_member(client, casdoor, admin):
    _, _, headers = admin()
    old = uid("old")
    sub = casdoor.add(old, "cmc_lead", "kb_editor")
    member_id = pm_member(old)  # 未绑定：改名同时完成绑定
    new = uid("new")
    response = client.post(f"{URL}/{sub}/username", json={"username": new.upper()}, headers=headers)
    assert response.status_code == 204
    assert old not in casdoor.users and casdoor.users[new]["id"] == sub
    assert casdoor.roles_of(new) == ["cmc_lead", "kb_editor"]
    assert fetch(User, id=member_id).username == new
    assert fetch(IAMIdentity, issuer=settings.casdoor_issuer, subject=sub).user_id == member_id
    clash = uid("clash")
    pm_member(clash)
    response = client.post(f"{URL}/{sub}/username", json={"username": clash}, headers=headers)
    assert response.status_code == 409


def test_reset_password_requires_change_on_next_login(client, casdoor, admin, token_factory):
    _, _, headers = admin()
    name = uid("reset")
    sub = casdoor.add(name, "rd")
    weak = client.post(f"{URL}/{sub}/password", json={"password": "abc"}, headers=headers)
    assert weak.status_code == 422
    old_session = open_portal_session(token_factory, sub, name)
    ok = client.post(f"{URL}/{sub}/password", json={"password": "Reset-2026a"}, headers=headers)
    assert ok.status_code == 204
    assert casdoor.users[name]["password"] == "Reset-2026a"
    assert casdoor.users[name]["needUpdatePassword"] is False and flagged(sub)
    assert fetch(PortalSession, id=security.digest(old_session)) is None  # 已登录的会话失效
    log = fetch(AuditLog, action="重置密码", target_id=sub[:40])
    assert "Reset-2026a" not in log.detail


def test_delete_clears_roles_first_and_keeps_member_history(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("gone")
    sub = casdoor.add(name, "rd", "kb_editor", "dikw-admin")
    member_id = pm_member(name, bind_to=sub)
    assert client.delete(f"{URL}/{sub}", headers=headers).status_code == 204
    assert name not in casdoor.users and casdoor.roles_of(name) == []
    assert casdoor.calls.index("delete-user") > casdoor.calls.index("update-role")
    member = fetch(User, id=member_id)
    assert member is not None and not member.is_active
    assert fetch(IAMIdentity, issuer=settings.casdoor_issuer, subject=sub) is None
    assert client.delete(f"{URL}/{sub}", headers=headers).status_code == 404


def test_repair_member_does_not_grant_knowledge_editor(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("fix")
    sub = casdoor.add(name, "cmc_lead")
    assert client.post(f"{URL}/{sub}/repair", headers=headers).status_code == 204
    assert casdoor.roles_of(name) == ["cmc_lead"]
    member = fetch(User, username=name)
    assert member.role == "cmc_lead" and member.is_active
    _, issues = listing(client, headers)
    assert [i["kind"] for i in issues if i["username"] == name] == ["kb_missing"]

    sleepy = uid("sleepy")
    sleepy_sub = casdoor.add(sleepy, "kb_editor")
    sleepy_member = pm_member(sleepy, bind_to=sleepy_sub, active=False)
    assert client.post(f"{URL}/{sleepy_sub}/repair", headers=headers).status_code == 204
    assert fetch(User, id=sleepy_member).is_active
    assert casdoor.roles_of(sleepy) == ["kb_editor"]


# —— 首次登录 / 重置后的改密在工作台内完成 —— #


def test_casdoor_force_flag_is_reported_and_migrated(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("stuck")
    sub = casdoor.add(name, "kb_editor", needUpdatePassword=True)  # 如在 IAM 管理台打开过该开关
    _, issues = listing(client, headers)
    assert ("iam_password_flag", name) in {(i["kind"], i["username"]) for i in issues}
    assert client.post(f"{URL}/{sub}/repair", headers=headers).status_code == 204
    assert casdoor.users[name]["needUpdatePassword"] is False and flagged(sub)
    accounts, issues = listing(client, headers)
    assert accounts[name]["must_change_password"] is True
    assert not [i for i in issues if i["username"] == name]


def test_portal_password_change_clears_flag(client, casdoor, admin, token_factory):
    _, _, headers = admin()
    body = new_account()
    assert client.post(URL, json=body, headers=headers).status_code == 204
    name, sub = body["username"], casdoor.users[body["username"]]["id"]
    sid = open_portal_session(token_factory, sub, name, roles=("kb_editor",))
    own = {"Cookie": f"{PORTAL_SESSION_COOKIE}={sid}", "Origin": settings.portal_origin}
    me = client.get("/api/v1/portal/me", headers=own).json()
    assert me["must_change_password"] is True
    url = "/api/v1/portal/password"
    weak = {"current_password": "Welcome-2026", "new_password": "short"}
    assert client.post(url, json=weak, headers=own).status_code == 422
    empty = {"current_password": "", "new_password": "Brand-new-2026"}
    assert client.post(url, json=empty, headers=own).status_code == 422  # 必须带当前密码
    wrong = {"current_password": "Wrong-pass-1", "new_password": "Brand-new-2026"}
    assert client.post(url, json=wrong, headers=own).status_code == 400
    no_origin = {"Cookie": own["Cookie"]}
    good = {"current_password": "Welcome-2026", "new_password": "Brand-new-2026"}
    assert client.post(url, json=good, headers=no_origin).status_code == 403
    assert client.post(url, json=good, headers=own).status_code == 204
    assert casdoor.users[name]["password"] == "Brand-new-2026" and not flagged(sub)
    assert client.get("/api/v1/portal/me", headers=own).json()["must_change_password"] is False


def test_flagged_admin_must_change_password_before_account_management(client, casdoor, admin):
    sub, _, headers = admin()
    db = SessionLocal()
    try:
        from app.services import password_policy

        password_policy.require_change(db, sub, "reset")
        db.commit()
    finally:
        db.close()
    response = client.get(URL, headers=headers)
    assert response.status_code == 403 and "临时密码" in response.json()["detail"]


def test_delete_clears_flag_and_sessions(client, casdoor, admin, token_factory):
    _, _, headers = admin()
    body = new_account()
    assert client.post(URL, json=body, headers=headers).status_code == 204
    name, sub = body["username"], casdoor.users[body["username"]]["id"]
    sid = open_portal_session(token_factory, sub, name)
    assert client.delete(f"{URL}/{sub}", headers=headers).status_code == 204
    assert not flagged(sub) and fetch(PortalSession, id=security.digest(sid)) is None


def test_knowledge_manager_is_an_independent_application_role(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("kb-owner")
    sub = casdoor.add(name, "rd", "kb_viewer", "dikw-admin")
    casdoor.roles["kb_manager"] = {
        "owner": settings.CASDOOR_ORG,
        "name": "kb_manager",
        "isEnabled": True,
        "users": [],
    }
    response = client.patch(f"{URL}/{sub}", json={"kb_role": "manager"}, headers=headers)
    assert response.status_code == 204, response.text
    assert casdoor.roles_of(name) == ["dikw-admin", "kb_manager", "rd"]
    accounts, _ = listing(client, headers)
    assert accounts[name]["kb_role"] == "manager"
    assert accounts[name]["kb_enabled"] is True
    assert accounts[name]["pm_identity"] == "staff"
    assert accounts[name]["platform_admin"] is False
    response = client.patch(f"{URL}/{sub}", json={"kb_role": "editor"}, headers=headers)
    assert response.status_code == 204
    assert casdoor.roles_of(name) == ["dikw-admin", "kb_editor", "rd"]


def test_create_knowledge_manager_does_not_grant_platform_or_project_lead(client, casdoor, admin):
    _, _, headers = admin()
    casdoor.roles["kb_manager"] = {
        "owner": settings.CASDOOR_ORG,
        "name": "kb_manager",
        "isEnabled": True,
        "users": [],
    }
    payload = new_account(kb_role="manager")
    response = client.post(URL, json=payload, headers=headers)
    assert response.status_code == 204, response.text
    assert casdoor.roles_of(payload["username"]) == ["kb_manager"]
