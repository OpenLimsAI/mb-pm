import json
from datetime import timedelta

import pytest

from app.db.session import SessionLocal
from app.models import Task
from app.models.pm_ai import PMAIRun
from app.services import ai, pm_ai_runs


@pytest.fixture(autouse=True)
def isolate_runs(monkeypatch, live_ai_roles):
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda db: {
            "provider": "ollama",
            "providers": {
                "ollama": {
                    "model": "test-model",
                    "base_url": "http://localhost:11434",
                    "api_key": "",
                }
            },
        },
    )
    yield
    with SessionLocal() as db:
        db.query(PMAIRun).delete()
        db.commit()


def queue(client, headers, pid, **values):
    response = client.post(
        "/api/v1/pm-ai/runs",
        headers=headers,
        json={"scenario": "priorities", "project_ids": [pid], **values},
    )
    assert response.status_code == 202, response.text
    return response.json()


def answer(messages):
    context = json.loads(messages[-1]["content"])["context"]
    return json.dumps(
        {
            "summary": "先核对待办",
            "findings": [
                {
                    "title": "需要跟进",
                    "detail": "当前任务记录需要跟进",
                    "evidence_ids": [context["tasks"][0]["evidence_id"]],
                }
            ],
            "draft_actions": [],
        }
    ), {"total_tokens": 42, "secret": "never-store"}


def test_member_context_only_contains_visible_tasks(
    client, auth_headers, project_factory, iam_user, bearer
):
    uid = iam_user("pm-ai-member", "rd")
    pid = project_factory("t-admin", member_ids=(uid,))
    with SessionLocal() as db:
        task = db.get(Task, f"{pid}-t2")
        task.owner_id = "t-admin"
        task.notes = "private task notes"
        task.cost_budget = 100
        db.commit()
    headers = bearer(uid, "rd")
    response = client.get(f"/api/v1/pm-ai/context?project_id={pid}", headers=headers)
    assert response.status_code == 200, response.text
    data = response.json()
    assert [row["id"] for row in data["tasks"]] == [f"{pid}-t1"]
    assert data["metrics"]["visible_tasks"] == 1
    assert "private task notes" not in response.text
    assert "cost_budget" not in response.text and "actual_cost" not in response.text
    assert data["dependencies"] == []
    response = client.post(
        "/api/v1/pm-ai/runs",
        headers=headers,
        json={"scenario": "explain", "project_ids": [pid], "task_ids": [f"{pid}-t2"]},
    )
    assert response.status_code == 404


def test_run_keeps_evidence_and_rejects_duplicate_work(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    monkeypatch.setattr(ai, "chat", lambda provider, config, messages, **kwargs: answer(messages))
    first = queue(client, auth_headers, pid)
    assert queue(client, auth_headers, pid)["id"] == first["id"]
    response = client.post(
        "/api/v1/pm-ai/runs",
        headers=auth_headers,
        json={"scenario": "weekly", "project_ids": [pid]},
    )
    assert response.status_code == 409
    assert pm_ai_runs.process_one()
    response = client.get(f"/api/v1/pm-ai/runs/{first['id']}", headers=auth_headers)
    assert response.status_code == 200, response.text
    done = response.json()
    assert done["state"] == "succeeded"
    assert done["usage"] == {"total_tokens": 42}
    assert done["result"]["findings"][0]["evidence_ids"][0] in {
        ref["id"] for ref in done["source"]["refs"]
    }
    assert done["source"]["complete"]


def test_cancel_before_and_during_model_call_discards_results(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    first = queue(client, auth_headers, pid)
    assert (
        client.post(f"/api/v1/pm-ai/runs/{first['id']}/cancel", headers=auth_headers).json()[
            "state"
        ]
        == "cancelled"
    )
    monkeypatch.setattr(ai, "chat", lambda *a, **k: pytest.fail("cancelled run called model"))
    assert not pm_ai_runs.process_one()
    second = queue(client, auth_headers, pid)

    def cancel(provider, config, messages, **kwargs):
        response = client.post(f"/api/v1/pm-ai/runs/{second['id']}/cancel", headers=auth_headers)
        assert response.status_code == 200
        return answer(messages)

    monkeypatch.setattr(ai, "chat", cancel)
    assert pm_ai_runs.process_one()
    row = client.get(f"/api/v1/pm-ai/runs/{second['id']}", headers=auth_headers).json()
    assert row["state"] == "cancelled" and row["result"] is None


def test_model_cannot_cite_unread_sources(client, auth_headers, project_factory, monkeypatch):
    pid = project_factory("t-admin")
    run = queue(client, auth_headers, pid)
    monkeypatch.setattr(
        ai,
        "chat",
        lambda *a, **k: (
            json.dumps(
                {
                    "summary": "bad",
                    "findings": [
                        {"title": "bad", "detail": "bad", "evidence_ids": ["task:not-visible"]}
                    ],
                    "draft_actions": [],
                }
            ),
            {},
        ),
    )
    assert pm_ai_runs.process_one()
    row = client.get(f"/api/v1/pm-ai/runs/{run['id']}", headers=auth_headers).json()
    assert row["state"] == "failed" and row["result"] is None


def test_old_broad_context_is_hidden_after_scope_or_role_change(
    client, auth_headers, project_factory, iam_user, bearer, monkeypatch
):
    uid = iam_user("pm-ai-lead", "project_lead")
    pid = project_factory(uid)
    headers = bearer(uid, "project_lead")
    first = queue(client, headers, pid)
    monkeypatch.setattr(ai, "chat", lambda provider, config, messages, **kwargs: answer(messages))
    assert pm_ai_runs.process_one()
    monkeypatch.setattr("app.services.accounts.live_roles", lambda subject: {"rd"})
    response = client.get(f"/api/v1/pm-ai/runs/{first['id']}", headers=headers)
    assert response.status_code == 403


def test_meeting_has_input_evidence_but_no_attachment_blob(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    run = queue(
        client, auth_headers, pid, scenario="meeting", material="会议决定：负责人核对交付日期"
    )
    assert any(ref["id"] == "material:meeting" for ref in run["source"]["refs"])
    assert "context" not in run
    assert (
        client.post(
            "/api/v1/pm-ai/runs", headers=auth_headers, json={"scenario": "meeting", "material": ""}
        ).status_code
        == 422
    )


def test_focused_context_contains_visible_dependency_endpoints(
    client, auth_headers, project_factory
):
    from app.models import User
    from app.services.pm_ai_context import ContextRequest, build_context

    pid = project_factory("t-admin")
    with SessionLocal() as db:
        data = build_context(
            db, db.get(User, "t-admin"), ContextRequest(project_ids=[pid], task_ids=[f"{pid}-t2"])
        )
    assert data["focus_task_ids"] == [f"{pid}-t2"]
    assert {row["id"] for row in data["tasks"]} == {f"{pid}-t1", f"{pid}-t2"}
    assert len(data["dependencies"]) == 1
    assert data["dependencies"][0]["evidence_id"] in {ref["id"] for ref in data["source"]["refs"]}


def test_meeting_evidence_preserves_line_numbers(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    run = queue(
        client, auth_headers, pid, scenario="meeting", material=" first action\n\nsecond action"
    )
    refs = {ref["id"]: ref for ref in run["source"]["refs"]}
    assert refs["material:1"]["excerpt"] == "first action"
    assert refs["material:3"]["excerpt"] == "second action"


@pytest.mark.parametrize(
    "action",
    [
        {"kind": "delete_project"},
        {"kind": "task_update", "task_id": "not-visible"},
        {"kind": "task_create", "owner_id": "not-visible"},
        {"kind": "task_update", "progress": 101},
        {"kind": "task_update", "progress": 25.5},
        {"kind": "task_update", "status": "已验证"},
    ],
)
def test_model_drafts_reject_unsupported_fields_or_scope(
    client, auth_headers, project_factory, action
):
    from app.models import User
    from app.services.pm_ai_context import ContextRequest, build_context

    pid = project_factory("t-admin")
    with SessionLocal() as db:
        context = build_context(db, db.get(User, "t-admin"), ContextRequest(project_ids=[pid]))
    action.update(reason="测试依据", evidence_ids=[context["source"]["refs"][0]["id"]])
    with pytest.raises(ai.AIError):
        pm_ai_runs.validate_result(
            json.dumps({"summary": "草稿", "findings": [], "draft_actions": [action]}), context
        )


def test_completed_run_is_marked_stale_after_task_change(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    monkeypatch.setattr(ai, "chat", lambda provider, config, messages, **kwargs: answer(messages))
    run = queue(client, auth_headers, pid)
    assert pm_ai_runs.process_one()
    url = f"/api/v1/pm-ai/runs/{run['id']}"
    assert client.get(url, headers=auth_headers).json()["stale"] is False
    with SessionLocal() as db:
        db.get(Task, f"{pid}-t1").progress = 10
        db.commit()
    assert client.get(url, headers=auth_headers).json()["stale"] is True


def test_history_filters_effective_scope_before_pagination(client, auth_headers, project_factory):
    pid = project_factory("t-admin")
    other = project_factory("t-admin")
    task_id = f"{pid}-t1"
    first = queue(client, auth_headers, pid, project_ids=[], task_ids=[task_id])
    assert first["scope"] == {"project_ids": [pid], "task_ids": [task_id]}
    assert first["review_url"] == f"/projects/{pid}?aiRun={first['id']}"
    with SessionLocal.begin() as db:
        stored = db.get(PMAIRun, first["id"])
        for index in range(31):
            db.add(
                PMAIRun(
                    id=f"unrelated-history-{index}",
                    created_by=stored.created_by,
                    created_at=stored.created_at + timedelta(seconds=index + 1),
                    state="cancelled",
                    request={"scenario": "priorities", "project_ids": [other]},
                    context={"scope": {"project_ids": [other], "task_ids": []}},
                    source={},
                )
            )
    url = "/api/v1/pm-ai/runs"
    latest = client.get(url, headers=auth_headers, params={"page_size": 1}).json()
    assert latest["items"][0]["id"] != first["id"]
    for scope in (
        {"project_id": pid},
        {"project_id": pid, "task_id": task_id},
        {"task_id": task_id},
    ):
        response = client.get(url, headers=auth_headers, params={"page_size": 1, **scope})
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        assert [item["id"] for item in response.json()["items"]] == [first["id"]]


def test_saved_run_remains_readable_if_new_context_exceeds_budget(
    client, auth_headers, project_factory, monkeypatch
):
    from app.api.v1 import pm_ai
    from app.services.pm_ai_context import ContextBudgetExceeded

    pid = project_factory("t-admin")
    monkeypatch.setattr(ai, "chat", lambda provider, config, messages, **kwargs: answer(messages))
    run = queue(client, auth_headers, pid)
    assert pm_ai_runs.process_one()

    def too_large(*args):
        raise ContextBudgetExceeded()

    monkeypatch.setattr(pm_ai, "build_context", too_large)
    response = client.get(f"/api/v1/pm-ai/runs/{run['id']}", headers=auth_headers)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["result"]["summary"] == "先核对待办"
    assert result["stale"] and result["stale_reason"] == "context_budget"


@pytest.mark.parametrize("provider", ["ollama", "deepseek"])
def test_generation_constrains_local_schema_and_bounds_hosted_output(
    client, auth_headers, project_factory, monkeypatch, provider
):
    from app.models import User
    from app.services.pm_ai_context import ContextRequest, build_context

    pid = project_factory("t-admin")
    request = ContextRequest(
        project_ids=[pid], scenario="meeting", material="测试任务 1进度更新为25%"
    )
    with SessionLocal() as db:
        context = build_context(db, db.get(User, "t-admin"), request)
    captured = {}

    def respond(provider, config, path, body=None, timeout=25):
        captured.update(body)
        content, _ = answer(body["messages"])
        if provider == "ollama":
            return {"message": {"content": content}}
        return {"choices": [{"message": {"content": content}}]}

    monkeypatch.setattr(ai, "request", respond)
    content, _ = pm_ai_runs.generate_analysis(
        provider, {"model": "test-model"}, request.model_dump(mode="json"), context
    )
    payload = json.loads(captured["messages"][-1]["content"])
    assert [row["id"] for row in payload["mentioned_tasks"]] == [f"{pid}-t1"]
    pm_ai_runs.validate_result(content, context)
    if provider == "ollama":
        schema = captured["format"]
        assert "maxLength" not in json.dumps(schema)
        assert "draft_actions" in schema["required"]
        assert "kind" in schema["$defs"]["Finding"]["required"]
        assert captured["options"]["temperature"] == 0
        refs = schema["$defs"]["Finding"]["properties"]["evidence_ids"]
        assert refs["minItems"] == 1
        assert set(refs["items"]["enum"]) == {ref["id"] for ref in context["source"]["refs"]}
        update_schema = schema["properties"]["draft_actions"]["items"]["oneOf"][0]
        assert update_schema["properties"]["kind"] == {"const": "task_update"}
        assert update_schema["additionalProperties"] is False
        assert set(update_schema["properties"]["task_id"]["enum"]) == {
            None,
            "",
            f"{pid}-t1",
            f"{pid}-t2",
        }
    else:
        assert "format" not in captured
        assert captured["max_tokens"] == 4096


def test_empty_evidence_context_disallows_unsupported_findings():
    schema = pm_ai_runs.output_schema(
        {
            "source": {"refs": []},
            "projects": [],
            "tasks": [],
            "sub_projects": [],
            "members": [],
            "register_entries": [],
        }
    )
    assert schema["properties"]["findings"]["maxItems"] == 0
    assert schema["properties"]["draft_actions"]["maxItems"] == 0


def test_task_draft_uses_snapshot_version_without_inventing_changed_fields():
    context = {
        "source": {"refs": [{"id": "task:t1"}]},
        "projects": [],
        "tasks": [{"id": "t1", "revision": 4}],
        "sub_projects": [],
        "members": [],
        "register_entries": [],
    }
    draft = {
        "kind": "task_update",
        "task_id": "t1",
        "progress": 25,
        "reason": "会议确认进度",
        "evidence_ids": ["task:t1"],
    }
    result = pm_ai_runs.validate_result(
        json.dumps({"summary": "待确认", "findings": [], "draft_actions": [draft]}), context
    )
    assert result["draft_actions"] == [{**draft, "expected_revision": 4}]
    draft["expected_revision"] = 3
    with pytest.raises(ai.AIError, match="版本与快照不符"):
        pm_ai_runs.validate_result(
            json.dumps({"summary": "待确认", "findings": [], "draft_actions": [draft]}), context
        )


def test_meeting_update_requires_target_and_material_evidence():
    context = {
        "source": {"refs": [{"id": ref} for ref in ("task:t1", "task:t2", "material:1")]},
        "projects": [],
        "tasks": [{"id": "t1", "revision": 4}],
        "sub_projects": [],
        "members": [],
        "register_entries": [],
        "material": "将 T1 进度更新至 25%",
    }
    action = {"kind": "task_update", "task_id": "t1", "progress": 25, "reason": "会议确认进度"}
    for refs, error in (
        (["task:t2", "material:1"], "目标记录"),
        (["task:t1"], "会议原文"),
    ):
        content = {"summary": "待确认", "draft_actions": [{**action, "evidence_ids": refs}]}
        with pytest.raises(ai.AIError, match=error):
            pm_ai_runs.validate_result(json.dumps(content), context)
    content = {
        "summary": "待确认",
        "draft_actions": [{**action, "evidence_ids": ["task:t1", "material:1"]}],
    }
    assert pm_ai_runs.validate_result(json.dumps(content), context)["draft_actions"]


@pytest.mark.parametrize("has_reference", [True, False])
def test_meeting_mentions_use_source_refs_for_older_snapshots(monkeypatch, has_reference):
    captured = {}

    def record(provider, config, messages, **kwargs):
        captured.update(json.loads(messages[-1]["content"]))
        return "{}", {}

    monkeypatch.setattr(ai, "chat", record)
    reference = {"id": "task:legacy-task", "type": "task", "entity_id": "legacy-task"}
    context = {
        "tasks": [{"id": "legacy-task", "name": "既有任务", "revision": 2}],
        "material": "既有任务进度更新为25%",
        "source": {"refs": [reference] if has_reference else []},
    }
    pm_ai_runs.generate_analysis(
        "ollama", {"model": "test-model"}, {"scenario": "meeting", "question": ""}, context
    )
    assert captured["mentioned_tasks"] == (
        [{**context["tasks"][0], "evidence_id": reference["id"]}] if has_reference else []
    )
