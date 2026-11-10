from datetime import date, timedelta

from app.api.v1 import pm_ai
from app.db.session import SessionLocal
from app.models import Project, Task

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
        "pm_agent_plan",
        "pm_work_priorities",
        "pm_compare_schedule",
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


def test_agent_plan_and_triage_share_scope_across_rest_and_mcp(
    client, auth_headers, project_factory, live_ai_roles
):
    project_id = project_factory("t-admin")
    with SessionLocal.begin() as db:
        project = db.get(Project, project_id)
        first = db.get(Task, f"{project_id}-t1")
        second = db.get(Task, f"{project_id}-t2")
        first.status, first.planned_end = "阻塞", date.today() + timedelta(days=15)
        second.status, second.planned_end = "未开始", date.today() + timedelta(days=3)
        question = {"question": f"{project.code} 工作重点只列1项"}
    plan = client.post("/api/v1/pm-ai/agent/plan", headers=auth_headers, json=question)
    assert plan.status_code == 200, plan.text
    plan = plan.json()
    assert plan["status"] == "ready" and plan["scenario"] == "priorities"
    assert plan["project_ids"] == [project_id] and plan["limit"] == 1
    mcp_plan = rpc(
        client, auth_headers, "tools/call", {"name": "pm_agent_plan", "arguments": question}
    )
    assert mcp_plan.json()["result"]["structuredContent"] == plan
    args = {"project_ids": plan["project_ids"], "limit": plan["limit"]}
    priorities = client.post("/api/v1/pm-ai/agent/triage", headers=auth_headers, json=args)
    assert priorities.status_code == 200, priorities.text
    result = priorities.json()
    assert [item["task_id"] for item in result["items"]] == [f"{project_id}-t1"]
    assert result["total_candidates"] == 2
    mcp_triage = rpc(
        client, auth_headers, "tools/call", {"name": "pm_work_priorities", "arguments": args}
    )
    assert mcp_triage.json()["result"]["structuredContent"] == result


def test_comparison_reuses_schedule_engine_and_only_confirmed_option_applies(
    client, auth_headers, project_factory, live_ai_roles, iam_user, bearer
):
    project_id = project_factory("t-admin")
    with SessionLocal.begin() as db:
        first = db.get(Task, f"{project_id}-t1")
        second = db.get(Task, f"{project_id}-t2")
        first.planned_start, first.planned_end = date(2026, 11, 2), date(2026, 11, 6)
        second.planned_start = second.planned_end = date(2026, 11, 10)
        second.is_milestone = True
    args = {
        "project_id": project_id,
        "task_id": f"{project_id}-t1",
        "delays": [1, 7],
        "locked_ids": [f"{project_id}-t2"],
    }
    response = client.post(
        "/api/v1/pm-ai/schedule/compare",
        headers=auth_headers,
        json=args,
    )
    assert response.status_code == 200, response.text
    short, long = response.json()["plans"]
    assert short["confirmation_token"] and not short["schedule"]["conflicts"]
    assert long["confirmation_token"] is None and long["schedule"]["conflicts"]
    tool_call = {"name": "pm_compare_schedule", "arguments": args}
    tool_response = rpc(client, auth_headers, "tools/call", tool_call).json()["result"]
    readonly = tool_response["structuredContent"]["plans"]
    assert [plan["schedule"] for plan in readonly] == [short["schedule"], long["schedule"]]
    assert all("confirmation_token" not in plan and "expires_at" not in plan for plan in readonly)
    member = iam_user("pm-ai-schedule-rd", "rd")
    refused = rpc(client, bearer(member, "rd"), "tools/call", tool_call).json()["result"]
    assert refused["isError"] and "structuredContent" not in refused
    with SessionLocal() as db:
        assert db.get(Task, f"{project_id}-t1").planned_end == date(2026, 11, 6)
    result = client.post(
        f"/api/v1/project-ai/projects/{project_id}/schedule-assist/apply",
        headers=auth_headers,
        json={"confirmation_token": short["confirmation_token"], "reason": "确认选定方案"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["schedule"] == short["schedule"]
