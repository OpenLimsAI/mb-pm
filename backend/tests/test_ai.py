import json
import stat
import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import pytest

from app.core.config import settings
from app.db.session import SessionLocal
from app.models import Project, ProjectAIAnalysis, SubProject, Task, User
from app.schemas.ai import AISettingsInput
from app.services import ai


@pytest.fixture(autouse=True)
def isolated_ai_settings(tmp_path, monkeypatch):
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
    assert stat.S_IMODE(__import__("os").stat(settings.AI_SETTINGS_PATH).st_mode) == 0o600
    payload = res.json()
    payload["providers"]["deepseek"]["api_key"] = ""
    client.put("/api/v1/ai/settings", json=payload, headers=auth_headers)
    assert ai.load_settings()["providers"]["deepseek"]["api_key"] == "test-secret-not-real"
    payload["providers"]["deepseek"]["base_url"] = "https://changed.example/v1"
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


def test_real_http_transports_and_connection_check(client, auth_headers):
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
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for provider, expected in (("custom", "cloud-test"), ("ollama", "local-test")):
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
    client, auth_headers, project, monkeypatch
):
    def fail(*args):
        raise ai.AIError("模型未配置")

    monkeypatch.setattr(ai, "analyze", fail)
    endpoint = f"/api/v1/projects/{project}/ai-analyses"
    assert client.post(endpoint, headers=auth_headers, json={}).status_code == 502
    assert client.get(endpoint, headers=auth_headers).json() == []
    uid = uuid4().hex[:20]
    with SessionLocal() as db:
        db.add(
            User(
                id=uid,
                username=uid,
                display_name="他人",
                email=uid + "@example.com",
                role="project_lead",
                is_active=True,
            )
        )
        db.commit()
    other = {"Authorization": "DemoUser " + uid}
    assert client.get(endpoint, headers=other).status_code == 404
    assert client.post(endpoint, headers=other, json={}).status_code == 404
    assert client.get("/api/v1/ai/settings", headers=other).status_code == 403


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
        ai.chat("custom", {"model": "test"}, [{"role": "user", "content": "test"}])


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
