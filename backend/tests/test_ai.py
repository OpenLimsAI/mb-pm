import json
import os
import stat
import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import pytest

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import Project, ProjectAIAnalysis, SubProject, Task
from app.schemas.ai import AISettingsInput
from app.services import ai


@pytest.fixture(autouse=True)
def isolated_ai_settings(tmp_path, monkeypatch, live_ai_roles):
    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(tmp_path / "ai.json"))


@pytest.fixture
def project(auth_headers):
    pid = uuid4().hex
    with SessionLocal() as db:
        db.add(
            Project(
                id=pid,
                code=pid,
                name="AI测试项目",
                product_type="单抗",
                current_stage="IND",
                target_stage="BLA",
                owner_id="t-admin",
                status="活跃",
                health="yellow",
                progress=20,
                planned_start=date.today() - timedelta(days=90),
                planned_end=date.today() + timedelta(days=90),
            )
        )
        db.flush()
        db.add(
            SubProject(
                id=pid + "-s",
                project_id=pid,
                name="上游",
                stage="IND",
                module="USP",
                status="进行中",
            )
        )
        db.flush()
        for suffix, state in (("a", "进行中"), ("b", "已验证")):
            db.add(
                Task(
                    id=pid + suffix,
                    code="USP-" + suffix,
                    name="测试任务",
                    sub_project_id=pid + "-s",
                    owner_id="t-admin",
                    status=state,
                    priority="高",
                    progress=20,
                    is_milestone=True,
                    planned_start=date.today() - timedelta(days=10),
                    planned_end=date.today() - timedelta(days=1),
                )
            )
        db.commit()
    return pid


def config_payload():
    cfg = ai.public_settings(ai.load_settings())
    cfg["providers"]["deepseek"]["api_key"] = "test-secret-not-real"
    return cfg


def test_settings_secrets_preserved_cleared_and_not_forwarded(client, auth_headers):
    payload = config_payload()
    res = client.put("/api/v1/ai/settings", json=payload, headers=auth_headers)
    assert res.status_code == 200
    assert "test-secret" not in res.text
    assert res.json()["providers"]["deepseek"]["key_set"]
    if os.name == "posix":  # Windows 不提供 POSIX 文件模式；生产 Linux 仍须严格为 0600。
        assert stat.S_IMODE(os.stat(settings.AI_SETTINGS_PATH).st_mode) == 0o600
    payload = res.json()
    payload["providers"]["deepseek"]["api_key"] = ""
    client.put("/api/v1/ai/settings", json=payload, headers=auth_headers)
    assert ai.load_settings()["providers"]["deepseek"]["api_key"] == "test-secret-not-real"
    payload["providers"]["deepseek"]["base_url"] = "https://api.deepseek.com/v1"
    client.put("/api/v1/ai/settings", json=payload, headers=auth_headers)
    assert not ai.load_settings()["providers"]["deepseek"]["api_key"]
    payload["providers"]["deepseek"].update(api_key="replacement", clear_key=False)
    client.put("/api/v1/ai/settings", json=payload, headers=auth_headers)
    payload["providers"]["deepseek"].update(api_key="", clear_key=True)
    assert client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).status_code == 200
    assert not client.get("/api/v1/ai/status", headers=auth_headers).json()["ready"]
    assert "api_key" not in client.get("/api/v1/ai/settings", headers=auth_headers).text


def test_settings_validation_and_permissions(client, auth_headers):
    assert client.get("/api/v1/ai/settings").status_code == 401
    payload = config_payload()
    payload["providers"]["deepseek"]["base_url"] = "file:///tmp/private"
    assert client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).status_code == 422
    payload = config_payload()
    payload["offline_fallback"] = True
    assert client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).status_code == 422


def test_real_http_transports_and_connection_check(client, auth_headers, monkeypatch):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):  # noqa: N802 -- stdlib callback
            result = (
                {"models": [{"name": "local-test"}]}
                if self.path == "/api/tags"
                else {"data": [{"id": "cloud-test"}]}
            )
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        def do_POST(self):  # noqa: N802 -- stdlib callback
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, body, self.headers.get("Authorization")))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {"message": {"content": "本地成功"}}
                    if self.path == "/api/chat"
                    else {"choices": [{"message": {"content": "云端成功"}}]}
                ).encode()
            )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    monkeypatch.setenv("AI_ALLOWED_INTERNAL_ORIGINS", f"http://127.0.0.1:{server.server_port}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for provider, expected in (("deepseek", "cloud-test"), ("ollama", "local-test")):
            payload = {
                "provider": provider,
                "config": {
                    "base_url": f"http://127.0.0.1:{server.server_port}",
                    "model": expected,
                    "api_key": "test",
                },
            }
            assert client.post("/api/v1/ai/models", headers=auth_headers, json=payload).json()[
                "models"
            ] == [expected]
            assert client.post("/api/v1/ai/test", headers=auth_headers, json=payload).json()["ok"]
        assert calls[0][0] == "/chat/completions" and calls[0][2] == "Bearer test"
        assert calls[1][0] == "/api/chat" and calls[1][2] is None
        assert all(not b["stream"] for _, b, _ in calls)
    finally:
        server.shutdown()
        server.server_close()


def test_generation_snapshot_history_stale_and_delete(client, auth_headers, project, monkeypatch):
    ai.save_settings(AISettingsInput(**config_payload()))
    prompts = []

    def mock_chat(provider, cfg, messages):
        prompts.append(messages)
        return "## 管理摘要\n根据 USP-a 的计划日期，建议跟进逾期任务。", {
            "total_tokens": 100,
            "secret": "must-not-return",
        }

    monkeypatch.setattr(ai, "chat", mock_chat)
    endpoint = f"/api/v1/projects/{project}/ai-analyses"
    res = client.post(endpoint, headers=auth_headers, json={"focus": "检查里程碑"})
    assert res.status_code == 201, res.text
    report = res.json()
    assert report["source"]["task_count"] == 2
    assert report["source"]["overdue_count"] == 1  # Verified tasks are never overdue.
    assert report["stale"] is False
    assert "secret" not in report["usage"]
    assert "USP-a" in prompts[0][1]["content"] and "检查里程碑" in prompts[0][1]["content"]
    assert "example.com" not in prompts[0][1]["content"]  # No user emails in the snapshot.
    assert client.get(endpoint, headers=auth_headers).json()[0]["id"] == report["id"]
    with SessionLocal() as db:
        db.get(Task, project + "a").progress = 50
        db.commit()
    assert client.get(endpoint, headers=auth_headers).json()[0]["stale"] is True
    assert client.delete(f"/api/v1/projects/{project}", headers=auth_headers).status_code == 204
    with SessionLocal() as db:
        assert db.get(ProjectAIAnalysis, report["id"]) is None


def test_failed_generation_does_not_save_and_scope_enforced(
    client, auth_headers, project, monkeypatch, iam_user, bearer
):
    def fail(*args):
        raise ai.AIError("模型未配置")

    monkeypatch.setattr(ai, "analyze", fail)
    endpoint = f"/api/v1/projects/{project}/ai-analyses"
    assert client.post(endpoint, headers=auth_headers, json={}).status_code == 502
    assert client.get(endpoint, headers=auth_headers).json() == []
    # 与该项目无关的项目负责人（经 IAM 绑定）：看不到、也不能分析该项目；项目负责人仍可配置共享 AI 服务
    uid = iam_user(uuid4().hex[:20], "project_lead")
    other = bearer(uid, "project_lead")
    assert client.get(endpoint, headers=other).status_code == 404
    assert client.post(endpoint, headers=other, json={}).status_code == 404
    assert client.get("/api/v1/ai/settings", headers=other).status_code == 200


def test_fallback_only_for_network_errors(monkeypatch):
    cfg = ai.load_settings()
    cfg["offline_fallback"] = True
    cfg["providers"]["ollama"]["model"] = "local-test"
    used = []

    def disconnected(provider, *args):
        used.append(provider)
        if provider != "ollama":
            raise ai.NetworkError("offline")
        return "分析", {}

    monkeypatch.setattr(ai, "chat", disconnected)
    result = ai.analyze(cfg, {}, "")
    assert used == ["deepseek", "ollama"] and result[3]["fallback"]

    def invalid_key(*args):
        raise ai.AIError("密钥无效")

    monkeypatch.setattr(ai, "chat", invalid_key)
    with pytest.raises(ai.AIError, match="密钥无效"):
        ai.analyze(cfg, {}, "")


@pytest.mark.parametrize(
    "result",
    [
        {"choices": []},
        {"choices": [{"message": "invalid"}]},
        {"choices": [{"message": {"content": ""}}]},
        {"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]},
    ],
)
def test_invalid_or_truncated_reply_is_not_a_report(monkeypatch, result):
    monkeypatch.setattr(ai, "request", lambda *args, **kwargs: result)
    with pytest.raises(ai.AIError):
        ai.chat("deepseek", {"model": "test"}, [{"role": "user", "content": "test"}])


def test_local_truncation_and_no_fallback_when_disabled(monkeypatch):
    monkeypatch.setattr(
        ai,
        "request",
        lambda *args, **kwargs: {"message": {"content": "partial"}, "done_reason": "length"},
    )
    with pytest.raises(ai.AIError, match="截断"):
        ai.chat("ollama", {"model": "test"}, [])

    def fail(*args):
        raise ai.NetworkError("offline")

    monkeypatch.setattr(ai, "chat", fail)
    with pytest.raises(ai.NetworkError):
        ai.analyze(ai.load_settings(), {}, "")


def test_analysis_prompt_default_custom_reset_and_limit(client, auth_headers):
    """默认分析提示词：系统默认 → 自定义 → 恢复默认；项目负责人通过 /ai/status 读到当前默认值。"""
    settings_now = client.get("/api/v1/ai/settings", headers=auth_headers).json()
    assert settings_now["analysis_prompt"] == ai.DEFAULT_ANALYSIS_PROMPT
    assert settings_now["default_analysis_prompt"] == ai.DEFAULT_ANALYSIS_PROMPT

    payload = config_payload()
    payload["analysis_prompt"] = "只分析里程碑延期风险，用表格列出。"
    saved = client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).json()
    assert saved["analysis_prompt"] == "只分析里程碑延期风险，用表格列出。"
    status = client.get("/api/v1/ai/status", headers=auth_headers).json()
    assert status["analysis_prompt"] == "只分析里程碑延期风险，用表格列出。"

    payload["analysis_prompt"] = ai.DEFAULT_ANALYSIS_PROMPT  # 恢复默认：只记「用默认」
    client.put("/api/v1/ai/settings", json=payload, headers=auth_headers)
    stored = json.loads(open(settings.AI_SETTINGS_PATH).read())
    assert stored["analysis_prompt"] == ""
    assert ai.load_settings()["analysis_prompt"] == ai.DEFAULT_ANALYSIS_PROMPT

    payload["analysis_prompt"] = "长" * 4001
    assert client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).status_code == 422


def test_generation_uses_default_prompt_or_temporary_override(
    client, auth_headers, project, monkeypatch
):
    payload = config_payload()
    payload["analysis_prompt"] = "默认：请重点评估里程碑风险。"
    ai.save_settings(AISettingsInput(**payload))
    prompts = []

    def mock_chat(provider, cfg, messages):
        prompts.append(messages)
        return "## 结论\n测试", {}

    monkeypatch.setattr(ai, "chat", mock_chat)
    endpoint = f"/api/v1/projects/{project}/ai-analyses"

    first = client.post(endpoint, headers=auth_headers, json={"focus": "里程碑"}).json()
    assert prompts[0][1]["content"].startswith("默认：请重点评估里程碑风险。")
    assert "以上原则为准" in prompts[0][0]["content"]  # 安全约束固定在系统消息中
    assert first["prompt"] == "默认：请重点评估里程碑风险。"

    second = client.post(
        endpoint, headers=auth_headers, json={"prompt": "临时：只列出三条建议。", "focus": ""}
    ).json()
    assert prompts[1][1]["content"].startswith("临时：只列出三条建议。")
    assert "默认：请重点评估里程碑风险。" not in prompts[1][1]["content"]
    assert second["prompt"] == "临时：只列出三条建议。"
    # 临时修改只对本次生效，不改变设置里的默认提示词
    assert ai.load_settings()["analysis_prompt"] == "默认：请重点评估里程碑风险。"


def test_removed_providers_rejected_and_legacy_settings_fall_back(client, auth_headers):
    payload = config_payload()
    payload["provider"] = "openai"
    assert client.put("/api/v1/ai/settings", json=payload, headers=auth_headers).status_code == 422
    with open(settings.AI_SETTINGS_PATH, "w") as f:
        json.dump({"provider": "custom", "providers": {"openai": {"api_key": "old"}}}, f)
    cfg = ai.load_settings()
    assert cfg["provider"] == "deepseek"
    assert set(cfg["providers"]) == {"deepseek", "minimax", "kimi", "ollama"}


def test_startup_adds_prompt_column_to_existing_table(tmp_path, monkeypatch):
    """已建过 project_ai_analyses 的老库：启动时补上 prompt 列，旧记录为空串。"""
    import app.main as main
    from sqlalchemy import create_engine, inspect, text

    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.execute(
            text("CREATE TABLE project_ai_analyses (id VARCHAR(40) PRIMARY KEY, focus TEXT)")
        )
        conn.execute(text("INSERT INTO project_ai_analyses (id, focus) VALUES ('old', '')"))
    monkeypatch.setattr(main, "engine", engine)
    main._ensure_schema()
    assert "prompt" in {c["name"] for c in inspect(engine).get_columns("project_ai_analyses")}
    with engine.connect() as conn:
        assert conn.execute(text("SELECT prompt FROM project_ai_analyses")).scalar() == ""
    engine.dispose()


@pytest.mark.parametrize(
    "role,allowed", [("admin", True), ("cmc_lead", True), ("project_lead", True), ("rd", False)]
)
def test_pm_ai_configuration_role_boundary(client, iam_user, bearer, role, allowed):
    # users.id 最多 20 字符；PostgreSQL 会执行长度约束，SQLite 不会。
    uid = iam_user(f"ai-cfg-{role}", role)
    response = client.get("/api/v1/ai/settings", headers=bearer(uid, role))
    assert response.status_code == (200 if allowed else 403)


@pytest.mark.parametrize("disabled,roles", [(False, []), (True, ["admin"])])
def test_pm_ai_configuration_rechecks_live_iam(client, auth_headers, monkeypatch, disabled, roles):
    from app.services import iam_admin

    saved = client.put("/api/v1/ai/settings", json=config_payload(), headers=auth_headers)
    assert saved.status_code == 200
    before = ai.load_settings()
    monkeypatch.setattr(
        iam_admin,
        "get_user_by_sub",
        lambda sub: {
            "isForbidden": disabled,
            "roles": [
                {"owner": settings.CASDOOR_ORG, "name": role, "isEnabled": True} for role in roles
            ],
        },
    )
    connection = {
        "provider": "deepseek",
        "config": {"base_url": "https://api.deepseek.com", "model": "deepseek-chat"},
    }
    # 登录时仍是管理员的旧令牌：角色被撤销或账号停用后，读取/保存/列模型/测试均被拒绝。
    for method, url, body in [
        ("GET", "/api/v1/ai/settings", None),
        ("PUT", "/api/v1/ai/settings", config_payload()),
        ("POST", "/api/v1/ai/models", connection),
        ("POST", "/api/v1/ai/test", connection),
    ]:
        assert client.request(method, url, json=body, headers=auth_headers).status_code == 403
    assert ai.load_settings() == before


def test_pm_ai_settings_cookie_requires_pm_origin(client, admin_user, token_factory):
    import time

    from app.core import security
    from app.models import IAMSession

    session_id = f"ai-settings-{uuid4().hex}"
    token = token_factory("admin", sub=admin_user)
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=security.digest(session_id),
                expires_at=int(time.time()) + 600,
                tokens=security.seal({"access_token": token}),
            )
        )
        db.commit()
    headers = {"Cookie": f"{security.SESSION_COOKIE}={session_id}"}
    assert client.get("/api/v1/ai/settings", headers=headers).status_code == 200
    payload = config_payload()
    assert client.put("/api/v1/ai/settings", json=payload, headers=headers).status_code == 403
    assert (
        client.put(
            "/api/v1/ai/settings",
            json=payload,
            headers={**headers, "Origin": "https://www.openlims.ai"},
        ).status_code
        == 403
    )
    response = client.put(
        "/api/v1/ai/settings", json=payload, headers={**headers, "Origin": settings.pms_origin}
    )
    assert response.status_code == 200
    assert "test-secret-not-real" not in response.text


@pytest.mark.parametrize("role", ["rd", "production", "qa_qc"])
def test_project_members_have_no_ai_endpoints(client, iam_user, bearer, role):
    user = iam_user("no-ai-" + role, role)
    headers = bearer(user, role)
    for method, endpoint, payload in [
        ("GET", "/api/v1/ai/settings", None),
        ("GET", "/api/v1/ai/status", None),
        ("PUT", "/api/v1/ai/settings", config_payload()),
        ("POST", "/api/v1/ai/models", {}),
        ("POST", "/api/v1/ai/test", {}),
        ("GET", "/api/v1/projects/hidden/ai-analyses", None),
        ("POST", "/api/v1/projects/hidden/ai-analyses", {}),
        ("GET", "/api/v1/finances/ai-analyses", None),
        ("POST", "/api/v1/finances/ai-analyses", {}),
    ]:
        response = client.request(method, endpoint, headers=headers, json=payload)
        assert response.status_code == 403, (role, endpoint, response.text)


def test_revoked_project_lead_cannot_use_ai_with_old_token(client, iam_user, bearer, monkeypatch):
    from app.services import iam_admin

    user = iam_user("revoked-ai-lead", "cmc_lead")
    monkeypatch.setattr(iam_admin, "get_user_by_sub", lambda sub: {"roles": []})
    for endpoint in [
        "/api/v1/ai/status",
        "/api/v1/projects/hidden/ai-analyses",
        "/api/v1/finances/ai-analyses",
    ]:
        assert client.get(endpoint, headers=bearer(user, "cmc_lead")).status_code == 403


@pytest.mark.parametrize("provider,profile_provider", [("kimi", None), ("", "kimi")])
@pytest.mark.parametrize("probe,limit,effort", [(True, 4096, "low"), (False, 16384, "high")])
def test_kimi_bounded_thinking_request(provider, profile_provider, probe, limit, effort):
    seen = []

    def request(provider, cfg, path, body, **kwargs):
        seen.append(body)
        return {"choices": [{"message": {"content": "连接成功"}, "finish_reason": "stop"}]}

    cfg = {"model": "kimi-k3.1-pro", "base_url": "https://api.moonshot.cn/v1", "api_key": "test"}
    if profile_provider:
        cfg["provider"] = profile_provider
    assert (
        ai.chat(
            provider, cfg, [{"role": "user", "content": "你好"}], probe=probe, request_fn=request
        )[0]
        == "连接成功"
    )
    assert seen[0]["max_completion_tokens"] == limit
    assert seen[0]["reasoning_effort"] == effort
    assert "temperature" not in seen[0] and "max_tokens" not in seen[0]


def test_old_settings_keep_existing_provider_and_add_kimi_defaults():
    path = settings.AI_SETTINGS_PATH
    with open(path, "w") as f:
        json.dump(
            {
                "provider": "deepseek",
                "providers": {
                    "deepseek": {"model": "existing-model", "api_key": "existing-secret"}
                },
            },
            f,
        )
    value = ai.load_settings()
    assert value["provider"] == "deepseek"
    assert value["providers"]["deepseek"]["api_key"] == "existing-secret"
    assert value["providers"]["kimi"]["model"] == "kimi-k3.1-pro"
