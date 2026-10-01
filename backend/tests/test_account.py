"""关闭自助注册 + 本人改用户名 / 改密码：用内存版 Casdoor 替身（按 v3 管理接口的真实返回形状），不访问外部 IAM。"""

import copy
import time
from uuid import uuid4

import httpx
import pytest

from app.api.v1 import auth as auth_api
from app.core import security
from app.core.config import Settings, settings
from app.db.session import SessionLocal
from app.models import IAMIdentity, IAMSession, User
from app.services import iam_admin

ORG = "mabpharm"
PASSWORD = "Current-pass1"


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
            for name in sorted(security.ROLES)
        }
        self.foreign_roles: list[dict] = []
        self.permissions = [
            {"owner": "built-in", "name": "permission-built-in", "users": ["built-in/*"]}
        ]
        self.calls: list[str] = []
        self.fail: dict[str, str] = {}

    def add(self, name, *, subject=None, role=None, password=PASSWORD):
        subject = subject or f"sub-{uuid4().hex}"
        self.users[name] = {
            "owner": ORG,
            "id": subject,
            "name": name,
            "displayName": name,
            "email": f"{name}@example.com",
            "password": password,
        }
        if role:
            self.roles[role]["users"].append(f"{ORG}/{name}")
        return subject

    @staticmethod
    def ok(data=None):
        return httpx.Response(200, json={"status": "ok", "msg": "", "data": data})

    @staticmethod
    def error(msg):
        return httpx.Response(200, json={"status": "error", "msg": msg, "data": None})

    def request(self, method, url, *, params=None, json=None, data=None, auth=None, **kwargs):
        # 只用应用凭据访问后端内部地址；不跟随代理环境变量
        assert auth == (settings.CASDOOR_CLIENT_ID, settings.CASDOOR_CLIENT_SECRET)
        assert url.startswith(settings.casdoor_internal_url + "/api/")
        assert kwargs["trust_env"] is False
        path = url.split("/api/", 1)[1]
        self.calls.append(path)
        mode = self.fail.get(path)
        if mode == "network":
            raise httpx.ConnectError("IAM unavailable")
        if mode == "error":
            response = self.error("模拟 IAM 拒绝")
        else:
            response = getattr(self, "_" + path.replace("-", "_"))(params or {}, json, data)
        if mode == "timeout-after-commit":
            raise httpx.ReadTimeout("response lost")
        response.request = httpx.Request(method, url)
        return response

    def _get_user(self, params, body, form):
        if params.get("userId"):
            user = next(
                (
                    u
                    for u in self.users.values()
                    if u["id"] == params["userId"] and u["owner"] == params.get("owner")
                ),
                None,
            )
        else:
            owner, _, name = params["id"].partition("/")
            user = self.users.get(name) if owner == ORG else None
        return self.ok({**user, "password": "***"} if user else None)

    def _add_user(self, params, body, form):
        if body["name"] in self.users:
            return self.error("用户名已存在")
        if any(u["email"] == body["email"] for u in self.users.values()):
            return self.error("邮箱已存在")
        assert body["owner"] == ORG and body["type"] == "normal-user"
        assert "isAdmin" not in body
        self.users[body["name"]] = {
            k: body[k] for k in ("owner", "id", "name", "displayName", "email", "password")
        }
        return self.ok("Affected")

    def _delete_user(self, params, body, form):
        assert body["owner"] == ORG
        self.users.pop(body["name"], None)
        return self.ok("Affected")

    def _get_role(self, params, body, form):
        _, _, name = params["id"].partition("/")
        return self.ok(copy.deepcopy(self.roles.get(name)))

    def _update_role(self, params, body, form):
        owner, _, name = params["id"].partition("/")
        # Casdoor 按整条记录（AllCols）更新：必须回传完整角色，不能丢字段
        assert body["owner"] == owner and body["name"] == name
        assert set(body) == set(self.roles[name])
        self.roles[name] = copy.deepcopy(body)
        return self.ok("Affected")

    def _check_user_password(self, params, body, form):
        user = self.users.get(body["name"])
        if not user or user["password"] != body["password"]:
            return self.error("密码或验证码错误，你还有 4 次尝试的机会")
        return self.ok()

    def _set_password(self, params, body, form):  # Casdoor 从表单读取参数
        user = self.users.get(form["userName"])
        if not user or user["password"] != form["oldPassword"]:
            return self.error("密码或验证码错误，你还有 4 次尝试的机会")
        if form["newPassword"] == form["oldPassword"]:
            return self.error("新密码必须与当前密码不同")
        user["password"] = form["newPassword"]
        return self.ok()

    def _update_user(self, params, body, form):
        assert params["columns"] == "name" and set(body) == {"owner", "name"}
        user = next(u for u in self.users.values() if u["id"] == params["userId"])
        if body["name"] in self.users:
            return self.error("用户名已存在")
        old = user["name"]
        del self.users[old]
        user["name"] = body["name"]
        self.users[user["name"]] = user
        # 真实 Casdoor 的 userChangeTrigger：只按用户名、不分组织改写角色成员
        for role in [*self.roles.values(), *self.foreign_roles]:
            role["users"] = [
                f"{m.partition('/')[0]}/{user['name']}" if m.partition("/")[2] == old else m
                for m in role["users"]
            ]
        return self.ok("Affected")

    def _get_roles(self, params, body, form):
        return self.ok([*self.roles.values(), *self.foreign_roles])

    def _get_permissions(self, params, body, form):
        return self.ok(self.permissions)


@pytest.fixture
def casdoor(client, token_factory, monkeypatch):
    fake = FakeCasdoor()
    monkeypatch.setattr(httpx, "request", fake.request)
    return fake


@pytest.fixture
def member(casdoor, iam_user):
    """已绑定 IAM 的业务用户 + 同名 Casdoor 账号：返回 (业务用户 ID, IAM 角色)。"""

    def make(role="rd"):
        user_id = iam_user(f"t-acct-{uuid4().hex[:8]}", role)
        casdoor.add(user_id, subject=user_id, role=role)
        return user_id

    return make


def origin():
    return {"Origin": settings.pms_origin}


def new_name(prefix="new"):
    return f"{prefix}.{uuid4().hex[:8]}"


def registration(**overrides):
    name = new_name("reg")
    return {
        "username": name,
        "display_name": "新同事",
        "email": f"{name}@example.com",
        "password": "Welcome-2026",
        **overrides,
    }


def row(model, **filters):
    db = SessionLocal()
    try:
        return db.query(model).filter_by(**filters).first()
    finally:
        db.close()


def open_session(token_factory, user_id, role):
    sid = f"sid-{uuid4().hex}"
    db = SessionLocal()
    try:
        db.add(
            IAMSession(
                id=security.digest(sid),
                expires_at=int(time.time()) + 600,
                tokens=security.seal(
                    {"access_token": token_factory(role, sub=user_id, name=user_id)}
                ),
            )
        )
        db.commit()
    finally:
        db.close()
    return sid


# —— 已停用自助注册 —— #


def test_legacy_signup_settings_cannot_reenable_registration(client, casdoor, monkeypatch):
    # 兼容旧服务器仍保留的环境变量：加载配置后也不能重新开启本系统注册。
    monkeypatch.setenv("IAM_SIGNUP_ENABLED", "true")
    monkeypatch.setenv("IAM_SIGNUP_ROLE", "admin")
    legacy_settings = Settings(_env_file=None, PMS_PUBLIC_URL="http://pms.test")
    monkeypatch.setattr(auth_api, "settings", legacy_settings)
    response = client.get("/api/v1/auth/config")
    assert response.status_code == 200
    assert response.json() == {
        "login_url": "http://pms.test/api/v1/auth/login",
        "signup_enabled": False,
    }
    assert client.post("/api/v1/auth/register", json=registration()).status_code == 410
    assert casdoor.calls == []


@pytest.mark.parametrize("request_origin", [None, "http://pms.test", "http://evil.test"])
@pytest.mark.parametrize("has_payload", [True, False])
def test_registration_is_retired_without_side_effects(client, casdoor, request_origin, has_payload):
    body = registration()
    subject = casdoor.add(body["username"], role="rd")
    users_before = copy.deepcopy(casdoor.users)
    roles_before = copy.deepcopy(casdoor.roles)
    db = SessionLocal()
    try:
        counts_before = (db.query(User).count(), db.query(IAMIdentity).count())
    finally:
        db.close()

    response = client.post(
        "/api/v1/auth/register",
        json=body if has_payload else None,
        headers={"Origin": request_origin} if request_origin else {},
    )
    assert response.status_code == 410
    assert response.json()["detail"] == "所有用户信息在iam平台管理"
    assert casdoor.calls == []
    assert casdoor.users == users_before and casdoor.roles == roles_before
    assert casdoor.users[body["username"]]["id"] == subject
    assert row(User, username=body["username"]) is None
    db = SessionLocal()
    try:
        assert (db.query(User).count(), db.query(IAMIdentity).count()) == counts_before
    finally:
        db.close()


# —— 改密码 —— #


def test_change_password_checks_current_password_and_signs_out_other_devices(
    client, casdoor, member, token_factory
):
    user_id = member()
    other_id = member()
    current = open_session(token_factory, user_id, "rd")
    elsewhere = open_session(token_factory, user_id, "rd")
    unrelated = open_session(token_factory, other_id, "rd")
    cookie = {"Cookie": f"{security.SESSION_COOKIE}={current}", **origin()}

    wrong = {"current_password": "Wrong-pass1", "new_password": "Brand-new-2026"}
    response = client.post("/api/v1/account/password", json=wrong, headers=cookie)
    assert response.status_code == 400 and "密码" in response.json()["detail"]
    assert casdoor.users[user_id]["password"] == PASSWORD

    body = {"current_password": PASSWORD, "new_password": "Brand-new-2026"}
    assert client.post("/api/v1/account/password", json=body, headers=cookie).status_code == 204
    assert casdoor.users[user_id]["password"] == "Brand-new-2026"
    assert row(IAMSession, id=security.digest(current)) is not None
    assert row(IAMSession, id=security.digest(elsewhere)) is None
    assert row(IAMSession, id=security.digest(unrelated)) is not None


def test_change_password_rules(client, casdoor, member, bearer, token_factory):
    user_id = member()
    headers = bearer(user_id, "rd")
    for weak in ["short1", "no-digits-here", "12345678901"]:
        body = {"current_password": PASSWORD, "new_password": weak}
        assert (
            client.post("/api/v1/account/password", json=body, headers=headers).status_code == 422
        )
    same = {"current_password": PASSWORD, "new_password": PASSWORD}
    response = client.post("/api/v1/account/password", json=same, headers=headers)
    assert response.status_code == 400 and "不同" in response.json()["detail"]
    # cookie 会话的写操作必须带可信 Origin
    sid = open_session(token_factory, user_id, "rd")
    body = {"current_password": PASSWORD, "new_password": "Brand-new-2026"}
    cookie = {"Cookie": f"{security.SESSION_COOKIE}={sid}"}
    assert client.post("/api/v1/account/password", json=body, headers=cookie).status_code == 403
    assert client.post("/api/v1/account/password", json=body).status_code == 401
    assert casdoor.users[user_id]["password"] == PASSWORD


# —— 改用户名 —— #


def test_change_username_renames_iam_account_and_business_user(client, casdoor, member, bearer):
    user_id = member("project_lead")
    db = SessionLocal()
    db.get(User, user_id).role = "rd"  # 业务库里的 users.role 不参与授权
    db.commit()
    db.close()
    target = new_name()
    body = {"new_username": target.upper(), "current_password": PASSWORD}
    headers = bearer(user_id, "project_lead")
    response = client.post("/api/v1/account/username", json=body, headers=headers)
    assert response.status_code == 200, response.text
    # 提交后重新加载的用户对象仍带 IAM 角色
    assert response.json()["username"] == target and response.json()["role"] == "project_lead"
    assert user_id not in casdoor.users and casdoor.users[target]["id"] == user_id
    assert casdoor.roles["project_lead"]["users"] == [f"{ORG}/{target}"]
    assert row(User, id=user_id).username == target
    # 绑定按 sub，不受改名影响：旧 token 仍对应同一业务用户
    me = client.get("/api/v1/auth/me", headers=bearer(user_id, "project_lead"))
    assert me.json()["id"] == user_id and me.json()["username"] == target


def test_change_username_rejections(client, casdoor, member, bearer, iam_user):
    user_id = member()
    headers = bearer(user_id, "rd")

    def attempt(name, password=PASSWORD):
        body = {"new_username": name, "current_password": password}
        return client.post("/api/v1/account/username", json=body, headers=headers)

    assert attempt(user_id).status_code == 400  # 与当前相同
    assert attempt("admin").status_code == 422  # 系统保留
    assert attempt("bad__name").status_code == 422
    # 预置业务用户占用的用户名
    assert attempt(iam_user(f"t-held.{uuid4().hex[:6]}", "rd")).status_code == 409
    # IAM 中已有同名账号
    elsewhere = new_name("iam")
    casdoor.add(elsewhere)
    response = attempt(elsewhere)
    assert response.status_code == 400 and "已存在" in response.json()["detail"]
    # 当前密码错误
    response = attempt(new_name(), "Wrong-pass1")
    assert response.status_code == 400 and "密码" in response.json()["detail"]
    assert casdoor.users[user_id]["id"] == user_id
    assert row(User, id=user_id).username == user_id


def test_change_username_refused_when_name_is_shared_across_orgs(client, casdoor, member, bearer):
    user_id = member()
    casdoor.foreign_roles.append(
        {"owner": "built-in", "name": "ops", "users": [f"built-in/{user_id}"]}
    )
    body = {"new_username": new_name(), "current_password": PASSWORD}
    response = client.post("/api/v1/account/username", json=body, headers=bearer(user_id, "rd"))
    assert response.status_code == 409
    assert "update-user" not in casdoor.calls
    assert casdoor.foreign_roles[0]["users"] == [f"built-in/{user_id}"]


def test_change_username_reverts_iam_rename_when_sync_fails(
    client, casdoor, member, bearer, iam_user, monkeypatch
):
    user_id = member()
    target = new_name()
    rename = iam_admin.rename_user

    def racing_rename(subject, name):
        rename(subject, name)
        if name == target:
            iam_user(target, "rd")  # 并发请求抢先占用了这个业务用户名

    monkeypatch.setattr(iam_admin, "rename_user", racing_rename)
    body = {"new_username": target, "current_password": PASSWORD}
    response = client.post("/api/v1/account/username", json=body, headers=bearer(user_id, "rd"))
    assert response.status_code == 409 and "已撤销" in response.json()["detail"]
    assert user_id in casdoor.users and target not in casdoor.users
    assert row(User, id=user_id).username == user_id


def test_account_changes_need_iam_service(client, casdoor, member, bearer):
    user_id = member()
    casdoor.fail["get-user"] = "network"
    body = {"current_password": PASSWORD, "new_password": "Brand-new-2026"}
    response = client.post("/api/v1/account/password", json=body, headers=bearer(user_id, "rd"))
    assert response.status_code == 503
    assert casdoor.users[user_id]["password"] == PASSWORD
