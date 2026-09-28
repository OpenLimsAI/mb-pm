"""自助注册 + 本人改用户名 / 改密码：用内存版 Casdoor 替身（按 v3 管理接口的真实返回形状），不访问外部 IAM。"""

import copy
import time
from uuid import uuid4

import httpx
import pytest

from app.api.v1 import auth as auth_api
from app.core import security
from app.core.config import settings
from app.db.session import SessionLocal
from app.models import IAMIdentity, IAMSession, User

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
    monkeypatch.setattr(settings, "IAM_SIGNUP_ENABLED", True)
    monkeypatch.setattr(settings, "IAM_SIGNUP_ROLE", "rd")
    auth_api._signup_hits.clear()
    yield fake
    auth_api._signup_hits.clear()


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


# —— 自助注册 —— #


def test_config_reports_signup(client, casdoor, monkeypatch):
    assert client.get("/api/v1/auth/config").json()["signup_enabled"] is True
    monkeypatch.setattr(settings, "IAM_SIGNUP_ENABLED", False)
    assert client.get("/api/v1/auth/config").json()["signup_enabled"] is False


def test_register_creates_iam_account_role_and_bound_user(client, casdoor, token_factory):
    body = registration(username="  New.Colleague-" + uuid4().hex[:4].upper() + " ")
    response = client.post("/api/v1/auth/register", json=body, headers=origin())
    assert response.status_code == 201, response.text
    username = body["username"].strip().lower()
    assert response.json() == {"username": username, "role": "rd"}

    account = casdoor.users[username]
    assert account["password"] == body["password"]
    assert casdoor.roles["rd"]["users"] == [f"{ORG}/{username}"]
    user = row(User, username=username)
    assert (user.display_name, user.email, user.role, user.is_active) == (
        "新同事",
        body["email"],
        "rd",
        True,
    )
    # IAM id 已预绑定：登录后按 sub 直接找到这个业务用户
    identity = row(IAMIdentity, subject=account["id"])
    assert identity.issuer == settings.casdoor_issuer and identity.user_id == user.id
    token = token_factory("rd", sub=account["id"], name=username)
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200 and me.json()["id"] == user.id and me.json()["role"] == "rd"


def test_register_requires_trusted_origin_and_enabled_signup(client, casdoor, monkeypatch):
    assert client.post("/api/v1/auth/register", json=registration()).status_code == 403
    bad = {"Origin": "http://evil.test"}
    assert client.post("/api/v1/auth/register", json=registration(), headers=bad).status_code == 403
    monkeypatch.setattr(settings, "IAM_SIGNUP_ENABLED", False)
    response = client.post("/api/v1/auth/register", json=registration(), headers=origin())
    assert response.status_code == 403
    monkeypatch.setattr(settings, "IAM_SIGNUP_ENABLED", True)
    # 管理角色不能作为自助注册的默认角色
    monkeypatch.setattr(settings, "IAM_SIGNUP_ROLE", "admin")
    response = client.post("/api/v1/auth/register", json=registration(), headers=origin())
    assert response.status_code == 503
    assert casdoor.calls == []


@pytest.mark.parametrize(
    "change",
    [
        {"username": "ab"},
        {"username": "bad..name"},
        {"username": "-lead"},
        {"username": "trail_"},
        {"username": "张三"},
        {"username": "admin"},
        {"username": "has space"},
        {"password": "short1"},
        {"password": "only-letters"},
        {"password": "1234567890"},
        {"password": "with space 1"},
        {"password": "中文密码abc123"},
        {"email": "not-an-email"},
        {"display_name": "   "},
    ],
)
def test_register_validation(client, casdoor, change):
    response = client.post("/api/v1/auth/register", json=registration(**change), headers=origin())
    assert response.status_code == 422
    assert casdoor.calls == []


def test_register_cannot_claim_existing_business_username_or_email(client, casdoor, iam_user):
    # 预置但尚未开通 IAM 的业务用户：首次登录按用户名关联，自助注册不能抢注
    existing = iam_user(f"t-pre.{uuid4().hex[:6]}", "rd")
    for change in [{"username": existing.upper()}, {"email": f"{existing}@EXAMPLE.com"}]:
        response = client.post(
            "/api/v1/auth/register", json=registration(**change), headers=origin()
        )
        assert response.status_code == 409
    assert casdoor.calls == []


def test_register_keeps_existing_iam_account_on_conflict(client, casdoor):
    body = registration()
    subject = casdoor.add(body["username"])
    response = client.post("/api/v1/auth/register", json=body, headers=origin())
    assert response.status_code == 409 and "已存在" in response.json()["detail"]
    assert casdoor.users[body["username"]]["id"] == subject
    assert "delete-user" not in casdoor.calls
    assert row(User, username=body["username"]) is None


def test_register_rolls_back_iam_account_when_role_assignment_fails(client, casdoor):
    casdoor.fail["update-role"] = "error"
    body = registration()
    response = client.post("/api/v1/auth/register", json=body, headers=origin())
    assert response.status_code == 503
    assert body["username"] not in casdoor.users
    assert row(User, username=body["username"]) is None


def test_register_cleans_up_account_when_iam_response_is_lost(client, casdoor):
    casdoor.fail["add-user"] = "timeout-after-commit"
    body = registration()
    response = client.post("/api/v1/auth/register", json=body, headers=origin())
    assert response.status_code == 503
    assert body["username"] not in casdoor.users
    assert row(User, username=body["username"]) is None


def test_register_never_deletes_someone_elses_account_on_ambiguous_failure(client, casdoor):
    body = registration()
    subject = casdoor.add(body["username"])  # 同名账号（非本次创建）
    casdoor.fail["add-user"] = "network"
    response = client.post("/api/v1/auth/register", json=body, headers=origin())
    assert response.status_code == 503
    assert casdoor.users[body["username"]]["id"] == subject
    assert "delete-user" not in casdoor.calls


def test_register_rolls_back_iam_account_when_database_insert_fails(
    client, casdoor, iam_user, monkeypatch
):
    body = registration()
    grant = auth_api.iam_admin.grant_role

    def racing_grant(name, role):
        grant(name, role)
        iam_user(body["username"], "rd")  # 并发请求抢先建了同名业务用户

    monkeypatch.setattr(auth_api.iam_admin, "grant_role", racing_grant)
    response = client.post("/api/v1/auth/register", json=body, headers=origin())
    assert response.status_code == 409
    assert body["username"] not in casdoor.users
    assert casdoor.roles["rd"]["users"] == []


def test_register_is_throttled_per_client(client, casdoor, iam_user):
    taken = iam_user(f"t-taken.{uuid4().hex[:6]}", "rd")
    codes = [
        client.post(
            "/api/v1/auth/register", json=registration(username=taken), headers=origin()
        ).status_code
        for _ in range(auth_api.SIGNUP_LIMIT + 1)
    ]
    assert codes == [409] * auth_api.SIGNUP_LIMIT + [429]


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
    rename = auth_api.iam_admin.rename_user

    def racing_rename(subject, name):
        rename(subject, name)
        if name == target:
            iam_user(target, "rd")  # 并发请求抢先占用了这个业务用户名

    monkeypatch.setattr(auth_api.iam_admin, "rename_user", racing_rename)
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
