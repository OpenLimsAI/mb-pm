from datetime import date

from app.api.v1 import pm_ai
from app.db.session import SessionLocal
from app.models import Task

ENDPOINT = "/api/v1/pm-ai/mcp"


def rpc(client, headers, method, params=None):
    return client.post(
        ENDPOINT,
        headers={**headers, "MCP-Protocol-Version": "2025-06-18"},
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
    )


def test_mcp_requires_identity_and_rejects_untrusted_origin(client, auth_headers):
    assert (
        client.post(ENDPOINT, json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    )
    response = rpc(client, {**auth_headers, "Origin": "https://outside.example"}, "ping")
    assert response.status_code == 403


def test_mcp_discovery_and_context_do_not_expose_business_writes(
    client, auth_headers, monkeypatch, live_ai_roles
):
    initialized = rpc(client, auth_headers, "initialize", {"protocolVersion": "2025-06-18"})
    assert initialized.status_code == 200
    assert initialized.json()["result"]["protocolVersion"] == "2025-06-18"
    result = rpc(client, auth_headers, "tools/list").json()["result"]
    names = {tool["name"] for tool in result["tools"]}
    assert names == {
        "pm_context",
        "pm_analyze",
        "pm_run_status",
        "pm_run_history",
        "pm_cancel_analysis",
    }
    monkeypatch.setattr(
        pm_ai, "get_context", lambda db, user, project_id: {"scope": project_id, "facts": []}
    )
    response = rpc(
        client,
        auth_headers,
        "tools/call",
        {"name": "pm_context", "arguments": {"project_id": "example"}},
    )
    assert response.json()["result"]["structuredContent"] == {"scope": "example", "facts": []}
    invalid = rpc(
        client,
        auth_headers,
        "tools/call",
        {"name": "pm_context", "arguments": {"unknown": "field"}},
    )
    assert invalid.json()["error"]["code"] == -32602
    forbidden = rpc(client, auth_headers, "tools/call", {"name": "apply_changes", "arguments": {}})
    assert forbidden.json()["error"]["code"] == -32602


def test_comparison_reuses_schedule_engine_and_only_confirmed_option_applies(
    client, auth_headers, project_factory, live_ai_roles
):
    project_id = project_factory("t-admin")
    with SessionLocal.begin() as db:
        first = db.get(Task, f"{project_id}-t1")
        second = db.get(Task, f"{project_id}-t2")
        first.planned_start, first.planned_end = date(2026, 11, 2), date(2026, 11, 6)
        second.planned_start = second.planned_end = date(2026, 11, 10)
        second.is_milestone = True
    response = client.post(
        "/api/v1/pm-ai/schedule/compare",
        headers=auth_headers,
        json={
            "project_id": project_id,
            "task_id": f"{project_id}-t1",
            "delays": [1, 7],
            "locked_ids": [f"{project_id}-t2"],
        },
    )
    assert response.status_code == 200, response.text
    short, long = response.json()["plans"]
    assert short["confirmation_token"] and not short["schedule"]["conflicts"]
    assert long["confirmation_token"] is None and long["schedule"]["conflicts"]
    with SessionLocal() as db:
        assert db.get(Task, f"{project_id}-t1").planned_end == date(2026, 11, 6)
    result = client.post(
        f"/api/v1/project-ai/projects/{project_id}/schedule-assist/apply",
        headers=auth_headers,
        json={"confirmation_token": short["confirmation_token"], "reason": "确认选定方案"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["schedule"] == short["schedule"]
