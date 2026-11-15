import copy
import json
from datetime import UTC, datetime, timedelta

import pytest

from app.db.session import SessionLocal
from app.models import Task
from app.models.pm_ai import PMAIRun
from app.services import ai, pm_ai_runs, pm_ai_workflow

CONFIG = {
    "provider": "deepseek",
    "providers": {
        "deepseek": {
            "model": "deepseek-v4-pro",
            "base_url": "https://api.deepseek.com",
            "api_key": "synthetic-test",
        }
    },
}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, live_ai_roles):
    monkeypatch.setattr(ai, "load_settings", lambda db: copy.deepcopy(CONFIG))
    yield
    with SessionLocal.begin() as db:
        db.query(PMAIRun).delete()


def queue(client, headers, pid, **values):
    response = client.post(
        "/api/v1/pm-ai/runs",
        headers=headers,
        json={"scenario": "weekly", "project_ids": [pid], **values},
    )
    assert response.status_code == 202, response.text
    return response.json()


def model_answer(body):
    context = json.loads(body["messages"][-1]["content"])["context"]
    findings = [
        {
            "kind": "fact",
            "title": task["name"],
            "detail": "按原任务记录分析",
            "evidence_ids": [task["evidence_id"]],
        }
        for task in context["tasks"]
    ][:8]
    actions = []
    material_refs = [
        ref["id"] for ref in context["source"]["refs"] if ref.get("type") == "material"
    ]
    if context.get("material"):
        for task in context["tasks"]:
            if task["name"] in context["material"]:
                actions.append(
                    {
                        "kind": "task_update",
                        "task_id": task["id"],
                        "expected_revision": task["revision"],
                        "progress": 25,
                        "notes": "已完成资料评审",
                        "reason": "会议明确更新",
                        "evidence_ids": [task["evidence_id"], material_refs[0]],
                    }
                )
    content = {"summary": "已完成本批资料核对", "findings": findings, "draft_actions": actions}
    return {
        "choices": [
            {
                "message": {"content": json.dumps(content, ensure_ascii=False)},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
    }


def fake(monkeypatch, callback=None):
    calls = []

    def request(provider, config, path, body=None, timeout=25):
        calls.append(copy.deepcopy(body))
        if callback:
            value = callback(len(calls), body)
            if value is not None:
                return value
        return model_answer(body)

    monkeypatch.setattr(ai, "request", request)
    return calls


def finish(client, headers, run_id):
    for _ in range(10):
        pm_ai_runs.process_one()
        current = client.get(f"/api/v1/pm-ai/runs/{run_id}", headers=headers).json()
        if current["state"] != "paused" or not current["workflow"]["can_resume"]:
            return current
        assert (
            client.post(f"/api/v1/pm-ai/runs/{run_id}/resume", headers=headers).status_code == 202
        )
    raise AssertionError("workflow did not finish within bounded continuation windows")


def large_tasks(pid, count=14):
    with SessionLocal.begin() as db:
        first = db.get(Task, f"{pid}-t1")
        for number in range(1, count + 1):
            task = db.get(Task, f"{pid}-t{number}")
            if task is None:
                task = Task(
                    id=f"{pid}-t{number}",
                    code=f"WF-{number}",
                    name=f"工作流任务{number}",
                    sub_project_id=first.sub_project_id,
                    owner_id=first.owner_id,
                    status="未开始",
                    priority="中",
                    planned_start=first.planned_start,
                    planned_end=first.planned_end,
                )
                db.add(task)
            task.name = f"工作流任务{number}"
    return "\n".join(
        f"工作流任务{number}进度更新为25%，进展说明为已完成资料评审。"
        for number in range(1, count + 1)
    )


def test_small_snapshot_uses_one_real_analysis_and_no_decorative_calls(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    calls = fake(monkeypatch)
    run = queue(client, auth_headers, pid)
    assert run["workflow"] and run["result"] is None
    assert pm_ai_runs.process_one()
    result = client.get(f'/api/v1/pm-ai/runs/{run["id"]}', headers=auth_headers).json()
    assert result["state"] == "succeeded" and len(calls) == 1
    assert result["workflow"]["completed_steps"] == result["workflow"]["total_steps"] == 1
    assert result["workflow"]["calls_used"] == 1
    assert result["usage"] == {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12}
    assert not any(
        key in json.dumps(result["workflow"])
        for key in ("api_key", "synthetic-test", '"input"', '"ledger"')
    )


def test_fourteen_meeting_updates_remain_complete_and_unapplied(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    material = large_tasks(pid)
    calls = fake(monkeypatch)
    run = queue(client, auth_headers, pid, scenario="meeting", material=material)
    result = finish(client, auth_headers, run["id"])
    assert result["state"] == "succeeded", result
    assert len(result["result"]["draft_actions"]) == 14
    assert all(
        action["progress"] == 25 and action["notes"] == "已完成资料评审"
        for action in result["result"]["draft_actions"]
    )
    assert len(calls) >= 3
    assert all(
        "derived" not in json.loads(body["messages"][-1]["content"])["context"]
        or not json.loads(body["messages"][-1]["content"])["context"]["tasks"]
        for body in calls
    )
    with SessionLocal() as db:
        assert all(
            task.progress == 0 for task in db.query(Task).filter(Task.sub_project_id == f"{pid}-sp")
        )


def test_window_pause_resume_is_same_run_idempotent_and_keeps_completed_checkpoint(
    client, auth_headers, project_factory, monkeypatch
):
    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    pid = project_factory("t-admin")
    material = large_tasks(pid)
    calls = fake(monkeypatch)
    run = queue(client, auth_headers, pid, scenario="meeting", material=material)
    assert pm_ai_runs.process_one()
    paused = client.get(f'/api/v1/pm-ai/runs/{run["id"]}', headers=auth_headers).json()
    assert paused["state"] == "paused" and paused["workflow"]["pause_reason"] == "window_call_limit"
    assert paused["workflow"]["completed_steps"] == 1 and paused["result"] is None
    first_input = copy.deepcopy(calls[0]["messages"][-1])
    before_reserved = paused["workflow"]["token_budget_used"]
    for _ in range(5):
        resumed = client.post(f'/api/v1/pm-ai/runs/{run["id"]}/resume', headers=auth_headers)
        assert resumed.status_code == 202 and resumed.json()["id"] == run["id"]
        number = resumed.json()["workflow"]["window"]["number"]
        assert (
            client.post(f'/api/v1/pm-ai/runs/{run["id"]}/resume', headers=auth_headers).json()[
                "workflow"
            ]["window"]["number"]
            == number
        )
        assert pm_ai_runs.process_one()
        current = client.get(f'/api/v1/pm-ai/runs/{run["id"]}', headers=auth_headers).json()
        if current["state"] == "succeeded":
            break
    assert current["state"] == "succeeded" and len(current["result"]["draft_actions"]) == 14
    assert current["workflow"]["token_budget_used"] > before_reserved
    assert sum(body["messages"][-1] == first_input for body in calls) == 1


def test_interruption_preserves_paid_reservation_and_does_not_rerun_completed_steps(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    material = large_tasks(pid)

    def crash(number, body):
        if number == 2:
            raise SystemExit("simulated worker death")

    calls = fake(monkeypatch, crash)
    run = queue(client, auth_headers, pid, scenario="meeting", material=material)
    with pytest.raises(SystemExit):
        pm_ai_runs.process_one()
    with SessionLocal.begin() as db:
        row = db.get(PMAIRun, run["id"])
        assert row.workflow["calls_used"] == 2 and len(row.workflow["ledger"]) == 2
        reserved = row.workflow["token_budget_used"]
        row.started_at = datetime.now(UTC) - timedelta(minutes=16)
    assert not pm_ai_runs.process_one()
    with SessionLocal() as db:
        row = db.get(PMAIRun, run["id"])
        assert row.state == "paused" and row.workflow["pause_reason"] == "process_interrupted"
        assert row.workflow["token_budget_used"] == reserved
    fake(monkeypatch)
    assert (
        client.post(f'/api/v1/pm-ai/runs/{run["id"]}/resume', headers=auth_headers).status_code
        == 202
    )
    assert finish(client, auth_headers, run["id"])["state"] == "succeeded"
    with SessionLocal() as db:
        row = db.get(PMAIRun, run["id"])
        assert row.state == "succeeded" and row.workflow["calls_used"] > 2
        assert (
            sum(
                item["id"] == "1" and item["state"] == "completed" for item in row.workflow["steps"]
            )
            == 1
        )
    assert len(calls) == 2


@pytest.mark.parametrize("change", ["snapshot", "model"])
def test_resume_refuses_changed_snapshot_or_model_without_replacing_checkpoints(
    client, auth_headers, project_factory, monkeypatch, change
):
    monkeypatch.setattr(pm_ai_workflow, "WINDOW_CALLS", 1)
    pid = project_factory("t-admin")
    material = large_tasks(pid)
    fake(monkeypatch)
    run = queue(client, auth_headers, pid, scenario="meeting", material=material)
    pm_ai_runs.process_one()
    with SessionLocal() as db:
        original = copy.deepcopy(db.get(PMAIRun, run["id"]).context)
    if change == "snapshot":
        with SessionLocal.begin() as db:
            db.get(Task, f"{pid}-t1").notes = "真实资料已变化"
    else:
        changed = copy.deepcopy(CONFIG)
        changed["providers"]["deepseek"]["model"] = "different-model"
        monkeypatch.setattr(ai, "load_settings", lambda db: changed)
    response = client.post(f'/api/v1/pm-ai/runs/{run["id"]}/resume', headers=auth_headers)
    assert response.status_code == 409
    with SessionLocal() as db:
        row = db.get(PMAIRun, run["id"])
        assert row.context == original and row.result is None
        assert row.workflow["pause_reason"] == f"{change}_changed"
        assert sum(step["state"] == "completed" for step in row.workflow["steps"]) == 1


def test_step_overflow_is_deterministically_subdivided_with_one_shared_repair(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    monkeypatch.setattr(pm_ai_workflow, "WINDOW_TOKENS", 1000000)

    def too_large(number, body):
        if number <= 2:
            return {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}

    calls = fake(monkeypatch, too_large)
    run = queue(client, auth_headers, pid)
    pm_ai_runs.process_one()
    result = client.get(f'/api/v1/pm-ai/runs/{run["id"]}', headers=auth_headers).json()
    assert result["state"] == "succeeded", result
    assert result["workflow"]["calls_used"] == len(calls) == 5
    with SessionLocal() as db:
        workflow = db.get(PMAIRun, run["id"]).workflow
        assert workflow["recovery_used"] and workflow["steps"][0]["state"] == "split"
        assert sum(item["calls"] > 1 for item in workflow["steps"]) == 1


def test_before_call_budget_cancel_and_permissions_have_no_business_writes(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    monkeypatch.setattr(pm_ai_workflow, "JOB_CALLS", 0)
    calls = fake(monkeypatch)
    run = queue(client, auth_headers, pid)
    pm_ai_runs.process_one()
    result = client.get(f'/api/v1/pm-ai/runs/{run["id"]}', headers=auth_headers).json()
    assert not calls and result["workflow"]["pause_reason"] == "job_call_limit"
    assert not result["workflow"]["can_resume"]
    assert (
        client.post(f'/api/v1/pm-ai/runs/{run["id"]}/cancel', headers=auth_headers).json()["state"]
        == "paused"
    )


def test_merge_keeps_disjoint_fields_and_stops_on_conflicting_values():
    common = {
        "kind": "task_update",
        "task_id": "t",
        "expected_revision": 1,
        "reason": "来自会议",
        "evidence_ids": ["task:t"],
    }
    results = [
        {"draft_actions": [{**common, "progress": 25}]},
        {
            "draft_actions": [
                {**common, "notes": "已完成资料评审", "evidence_ids": ["task:t", "material:1"]}
            ]
        },
    ]
    merged = pm_ai_workflow.merged_actions(results)
    assert (
        len(merged) == 1 and merged[0]["progress"] == 25 and merged[0]["notes"] == "已完成资料评审"
    )
    with pytest.raises(pm_ai_workflow.Paused, match="分步分析"):
        pm_ai_workflow.merged_actions([results[0], {"draft_actions": [{**common, "progress": 50}]}])


def test_old_null_workflow_runs_still_use_legacy_worker(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    calls = fake(monkeypatch)
    run = queue(client, auth_headers, pid)
    with SessionLocal.begin() as db:
        db.get(PMAIRun, run["id"]).workflow = None
    pm_ai_runs.process_one()
    result = client.get(f'/api/v1/pm-ai/runs/{run["id"]}', headers=auth_headers).json()
    assert result["state"] == "succeeded" and result["workflow"] is None and len(calls) == 1


def test_large_events_and_material_converge_without_losing_original_records_or_line_ids(
    client, auth_headers, project_factory
):
    from app.models import User
    from app.services.pm_ai_context import ContextRequest, build_context

    pid = project_factory("t-admin")
    material = "".join(
        f"第{number}行会议资料；需完整保留原始来源编号。\n" for number in range(1, 230)
    )
    with SessionLocal() as db:
        context = build_context(
            db,
            db.get(User, "t-admin"),
            ContextRequest(project_ids=[pid], scenario="meeting", material=material),
            workflow=True,
        )
    context["activities"] = []
    for number in range(32):
        context["activities"].append(
            {
                "id": f"event-{number}",
                "task_id": f"{pid}-t1",
                "body": f"原始记录{number}:" + "证" * 5000,
                "evidence_id": f"activity:event-{number}",
            }
        )
        context["source"]["refs"].append(
            {"id": f"activity:event-{number}", "type": "activity", "entity_id": f"event-{number}"}
        )
    workflow = pm_ai_workflow.initialize(context, CONFIG)
    parts = [item["input"] for item in workflow["steps"]]
    assert len(parts) > 1 and all(
        len(pm_ai_workflow.encoded(part)) <= pm_ai_workflow.BATCH_CHARS for part in parts
    )
    assert "".join(part["material"] for part in parts) == material
    assert {row["id"] for part in parts for row in part["activities"]} == {
        row["id"] for row in context["activities"]
    }
    assert {ref["id"] for part in parts for ref in part["source"]["refs"]} == {
        ref["id"] for ref in context["source"]["refs"]
    }
    for part in parts:
        start, end = (
            part.get("_material_start", 0),
            part.get("_material_start", 0) + len(part["material"]),
        )
        for ref in part["source"]["refs"]:
            if ref.get("type") == "material":
                assert part["material"] and ref["start_offset"] < end and ref["end_offset"] > start


def test_final_workflow_result_can_exceed_single_step_cap_but_still_validates_every_action(
    client, auth_headers, project_factory
):
    pid = project_factory("t-admin")
    run = queue(client, auth_headers, pid)
    with SessionLocal() as db:
        context = db.get(PMAIRun, run["id"]).context
    result = {
        "summary": "完整多批结论",
        "findings": [
            {
                "kind": "fact",
                "title": f"结论{index}",
                "detail": "证据说明" * 750,
                "evidence_ids": [f"task:{pid}-t1"],
            }
            for index in range(30)
        ],
        "draft_actions": [],
    }
    content = json.dumps(result, ensure_ascii=False)
    assert len(content) > 80000
    assert len(pm_ai_runs.validate_result(content, context, workflow=True)["findings"]) == 30
    result["draft_actions"] = [
        {
            "kind": "task_update",
            "task_id": "outside",
            "expected_revision": 1,
            "progress": 25,
            "reason": "bad",
            "evidence_ids": [f"task:{pid}-t1"],
        }
    ]
    with pytest.raises(ai.AIError):
        pm_ai_runs.validate_result(json.dumps(result, ensure_ascii=False), context, workflow=True)


def test_unavailable_model_after_queue_pauses_without_waiting_for_stale_timeout(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    calls = fake(monkeypatch)
    run = queue(client, auth_headers, pid)

    def unavailable(db):
        raise ValueError("PRIVATE_CONFIG_ERROR_NOT_PUBLIC")

    monkeypatch.setattr(ai, "load_settings", unavailable)
    assert pm_ai_runs.process_one()
    with SessionLocal() as db:
        row = db.get(PMAIRun, run["id"])
        assert row.state == "paused" and row.workflow["pause_reason"] == "model_configuration"
        assert row.workflow["calls_used"] == 0 and row.result is None
        assert "PRIVATE_CONFIG" not in row.error
    assert not calls


def test_dense_single_line_meeting_splits_at_task_boundaries_and_keeps_all_fourteen_updates(
    client, auth_headers, project_factory, monkeypatch
):
    pid = project_factory("t-admin")
    material = large_tasks(pid).replace("。\n", "，").rstrip("。")
    assert "\n" not in material and "。" not in material
    fake(monkeypatch)
    run = queue(client, auth_headers, pid, scenario="meeting", material=material)
    with SessionLocal() as db:
        pieces = [item["input"] for item in db.get(PMAIRun, run["id"]).workflow["steps"]]
        assert "".join(part["material"] for part in pieces) == material
        assert all(
            len(
                {
                    identifier
                    for _, _, identifier in pm_ai_workflow.mentioned_positions(
                        part, part["material"]
                    )
                }
            )
            <= 8
            for part in pieces
            if part["material"]
        )
    final = finish(client, auth_headers, run["id"])
    assert final["state"] == "succeeded" and len(final["result"]["draft_actions"]) == 14
    assert all(
        action["progress"] == 25 and action["notes"] == "已完成资料评审"
        for action in final["result"]["draft_actions"]
    )
