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
        self.fail: dict[str, str] = {}

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
        if self.fail.get(path) == "error":
            response = self.error("模拟 IAM 拒绝")
        else:
            response = getattr(self, "_" + path.replace("-", "_"))(params or {}, json, data)
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
    return {
        "username": uid("new"),
        "display_name": "新同事",
        "password": "Welcome-2026",
        "identity": "staff",
        "specialty_group": "上游",
        "weekly_hours": 36,
        **overrides,
    }


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
        "identity": "lead",
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
            url, json={"identity": "staff", "specialty_group": ""}, headers=headers
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
    payload = {"identity": "staff", "weekly_hours": 20}
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
    for body in ({"identity": "lead"}, {"specialty_group": "分析"}, {"display_name": "x"}):
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
    assert client.patch(own, json={"identity": "lead"}, headers=headers).status_code == 409
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


def test_repair_opens_kb_and_member(client, casdoor, admin):
    _, _, headers = admin()
    name = uid("fix")
    sub = casdoor.add(name, "cmc_lead")
    assert client.post(f"{URL}/{sub}/repair", headers=headers).status_code == 204
    assert casdoor.roles_of(name) == ["cmc_lead", "kb_editor"]
    member = fetch(User, username=name)
    assert member.role == "cmc_lead" and member.is_active
    _, issues = listing(client, headers)
    assert not [i for i in issues if i["username"] == name]

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
