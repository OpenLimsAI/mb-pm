"""Exercise the split runtime with a real queued request and an isolated model."""

import importlib.util
import json
from io import StringIO
from pathlib import Path
from time import monotonic, sleep

from fastapi.testclient import TestClient

from app import main, worker
from app.core.config import settings
from app.services import ai


def test_web_queues_project_job_for_standalone_worker(
    auth_headers, project_factory, live_ai_roles, monkeypatch, tmp_path
):
    project_id = project_factory("t-admin")
    monkeypatch.setattr(settings, "AI_SETTINGS_PATH", str(tmp_path / "ai.json"))
    monkeypatch.setattr(settings, "APP_PROCESS_ROLE", "web")
    monkeypatch.setattr(settings, "AUTO_MIGRATE_SCHEMA", False)
    monkeypatch.setenv("PROJECT_AI_WORKER_ENABLED", "true")
    calls = []

    def analyze(_config, _context, focus, _prompt):
        calls.append(focus)
        return "独立进程生成的报告", "deepseek", "test-model", {}

    monkeypatch.setattr(ai, "analyze", analyze)
    url = f"/api/v1/project-ai/projects/{project_id}/jobs"
    with TestClient(main.app) as web:
        queued = web.post(url, headers=auth_headers, json={"focus": "任务风险"})
        assert queued.status_code == 202, queued.text
        assert queued.json()["state"] == "queued"
        # The web lifecycle must never start workers even when a queue is enabled.
        assert calls == []

        monkeypatch.setattr(settings, "APP_PROCESS_ROLE", "worker")
        with TestClient(worker.app) as executor:
            assert executor.get("/health").json() == {"status": "ok", "role": "worker"}
            assert executor.post(url, headers=auth_headers, json={}).status_code == 404
            assert executor.get("/docs").status_code == 404
            deadline = monotonic() + 6
            while monotonic() < deadline:
                jobs = web.get(url, headers=auth_headers).json()
                job = next(item for item in jobs if item["id"] == queued.json()["id"])
                if job["state"] in {"succeeded", "failed"}:
                    break
                sleep(0.05)
            assert job["state"] == "succeeded", job
            assert job["analysis_id"] and calls == ["任务风险"]


def test_worker_overlay_keeps_backend_access_without_publishing_an_http_service(
    monkeypatch, tmp_path, capsys
):
    script = Path(__file__).resolve().parents[2] / "deploy/parallel-test/worker_overlay.py"
    spec = importlib.util.spec_from_file_location("worker_overlay", script)
    overlay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(overlay)
    image = "sha256:" + "a" * 64
    app = {
        "image": image,
        "user": "10001:10001",
        "read_only": True,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "mem_limit": 1536 * 1024**2,
        "cpus": 2,
        "pids_limit": 128,
        "networks": {"internal": {"aliases": ["app"]}, "edge": None},
        "ports": [{"published": "18082", "target": 8000}],
        "volumes": [
            {"type": "volume", "source": "information_originals", "target": "/data/information"}
        ],
        "environment": {
            "DATABASE_URL": "postgresql+psycopg://runtime:synthetic@db/mb_pm",
            "APP_SECRET": "synthetic$$application_secret",
            "SOLUTION_KB_TOKEN": "synthetic-private-knowledge-key",
            "PORTAL_CLIENT_SECRET": "synthetic-private-portal-key",
        },
    }
    source = {"services": {"app": app, "app-direct": {"image": image}}}
    output = tmp_path / "worker.private.json"
    monkeypatch.setattr("sys.stdin", StringIO(json.dumps(source)))
    monkeypatch.setattr("sys.argv", ["worker_overlay", "--output", str(output)])
    overlay.main()
    result = json.loads(output.read_text())["services"]
    assert output.stat().st_mode & 0o777 == 0o600
    assert (
        result["app"]["environment"]
        == result["app-direct"]["environment"]
        == {"APP_PROCESS_ROLE": "web"}
    )
    executor = result["worker"]
    assert executor["image"] == image and executor["volumes"] == app["volumes"]
    assert executor["networks"] == {"internal": None, "edge": None}
    assert "ports" not in executor and "127.0.0.1" in executor["command"]
    assert executor["environment"]["APP_SECRET"] == app["environment"]["APP_SECRET"]
    assert executor["environment"]["SOLUTION_KB_TOKEN"] == app["environment"]["SOLUTION_KB_TOKEN"]
    assert executor["environment"]["APP_PROCESS_ROLE"] == "worker"
    assert executor["environment"]["AUTO_MIGRATE_SCHEMA"] == "false"
    assert "PORTAL_CLIENT_SECRET" not in executor["environment"]
    assert "synthetic" not in capsys.readouterr().out
