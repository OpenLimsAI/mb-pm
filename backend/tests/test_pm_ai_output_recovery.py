import copy
import json

import pytest
from fastapi import HTTPException

from app.db.session import SessionLocal
from app.models import User
from app.models.pm_ai import PMAIRun
from app.services import ai, pm_ai_generation, pm_ai_runs

GOOD = {"summary": "本周无新增变更记录", "findings": [], "draft_actions": []}
CONFIG = {"model": "deepseek-v4-pro", "base_url": "https://api.deepseek.com"}


@pytest.fixture
def context():
    return {
        "source": {
            "refs": [{"id": "task:t1", "type": "task", "entity_id": "t1"}, {"id": "material:1"}]
        },
        "projects": [{"id": "p1"}],
        "tasks": [{"id": "t1", "name": "测试任务", "revision": 4}],
        "sub_projects": [],
        "members": [],
        "register_entries": [],
        "material": "",
    }


def response(content=GOOD, finish="stop", usage=None):
    return {
        "choices": [
            {
                "message": {
                    "content": json.dumps(content, ensure_ascii=False)
                    if isinstance(content, dict)
                    else content,
                    "reasoning_content": "NEVER_PERSIST_REASONING",
                },
                "finish_reason": finish,
            }
        ],
        "usage": usage if usage is not None else {},
    }


def transport(monkeypatch, replies):
    seen = []

    def call(provider, config, path, body=None, timeout=25):
        seen.append({"provider": provider, "body": copy.deepcopy(body), "timeout": timeout})
        result = replies[len(seen) - 1]
        if isinstance(result, Exception):
            raise result
        return copy.deepcopy(result)

    monkeypatch.setattr(ai, "request", call)
    return seen


def generate(context, **values):
    provider = values.pop("provider", "deepseek")
    config = values.pop("config", CONFIG)
    scenario = values.pop("scenario", "weekly")
    return pm_ai_runs.generate_analysis(
        provider, config, {"scenario": scenario, "question": "整理本周项目周报"}, context, **values
    )


@pytest.mark.parametrize(
    "scenario,budget,thinking",
    [
        ("weekly", 8192, "disabled"),
        ("meeting", 8192, "disabled"),
        ("priorities", 8192, "disabled"),
        ("followup", 8192, "disabled"),
        ("explain", 16384, "enabled"),
    ],
)
def test_official_deepseek_uses_pm_budget_and_json_contract(
    monkeypatch, context, scenario, budget, thinking
):
    seen = transport(monkeypatch, [response()])
    generate(context, scenario=scenario)
    body = seen[0]["body"]
    assert body["max_tokens"] == budget and body["thinking"] == {"type": thinking}
    assert body["response_format"] == {"type": "json_object"}
    assert body.get("reasoning_effort") == ("low" if scenario == "explain" else None)


@pytest.mark.parametrize(
    "config",
    [
        {"model": "deepseek-v4-pro", "base_url": "https://proxy.example/v1"},
        {"model": "unknown-model", "base_url": "https://api.deepseek.com"},
        {"model": "deepseek-v4-pro", "base_url": "https://api.deepseek.com/other"},
    ],
)
def test_unknown_endpoints_or_models_do_not_receive_vendor_switches(monkeypatch, context, config):
    seen = transport(monkeypatch, [response()])
    generate(context, config=config)
    assert not {"thinking", "reasoning_effort", "response_format"} & seen[0]["body"].keys()


def test_kimi_official_uses_low_effort_and_sixteen_k(monkeypatch, context):
    seen = transport(monkeypatch, [response()])
    generate(
        context,
        provider="kimi",
        config={"model": "kimi-k3.1-pro", "base_url": "https://api.moonshot.cn/v1"},
    )
    body = seen[0]["body"]
    assert body["max_completion_tokens"] == 16384 and body["reasoning_effort"] == "low"
    assert not {"max_tokens", "thinking", "response_format"} & body.keys()


def test_length_regenerates_whole_json_from_identical_snapshot_and_adds_usage(monkeypatch, context):
    context["material"] = "会议记录原文必须完整保留。" * 600
    snapshot = copy.deepcopy(context)
    seen = transport(
        monkeypatch,
        [
            response(
                '{"summary":"UNSAFE_PARTIAL',
                "length",
                {
                    "prompt_tokens": 40,
                    "completion_tokens": 80,
                    "total_tokens": 120,
                    "completion_tokens_details": {"reasoning_tokens": 70},
                    "secret": "NEVER_STORE",
                },
            ),
            response(usage={"prompt_tokens": 50, "completion_tokens": 60, "total_tokens": 110}),
        ],
    )
    content, usage = generate(context, scenario="meeting")
    assert json.loads(content) == GOOD and context == snapshot
    assert len(seen) == 2 and [x["body"]["max_tokens"] for x in seen] == [8192, 16384]
    assert seen[0]["body"]["messages"][1] == seen[1]["body"]["messages"][1]
    assert "UNSAFE_PARTIAL" not in json.dumps(seen[1])
    assert "NEVER_" not in json.dumps(usage)
    assert {key: usage[key] for key in pm_ai_generation.COUNTERS} == {
        "prompt_tokens": 90,
        "completion_tokens": 140,
        "total_tokens": 230,
    }
    metadata = usage["_generation"]
    assert metadata["recovered"] and metadata["recovery_attempted"]
    assert metadata["attempts"][0]["finish_reason"] == "length"
    assert metadata["attempts"][0]["usage"]["reasoning_tokens"] == 70


def test_meeting_recovery_keeps_progress_and_notes_in_the_unapplied_draft(monkeypatch, context):
    context["material"] = "测试任务进度更新为25%，进展说明为已完成资料评审。"
    action = {
        "kind": "task_update",
        "task_id": "t1",
        "expected_revision": 4,
        "progress": 25,
        "notes": "已完成资料评审",
        "reason": "会议明确更新",
        "evidence_ids": ["task:t1", "material:1"],
    }
    expected = {**GOOD, "draft_actions": [action]}
    seen = transport(monkeypatch, [response("", "length"), response(expected)])
    content, usage = generate(context, scenario="meeting")
    assert len(seen) == 2 and usage["_generation"]["recovered"]
    assert pm_ai_runs.validate_result(content, context, require_complete=True)["draft_actions"] == [
        action
    ]
    assert context["tasks"][0] == {"id": "t1", "name": "测试任务", "revision": 4}


@pytest.mark.parametrize(
    "bad,code",
    [
        ('{"summary":', "model_output_format"),
        ({"summary": "缺少数组"}, "model_output_format"),
        ({"findings": [], "draft_actions": []}, "model_output_format"),
        ("", "model_empty_response"),
    ],
)
def test_structural_or_empty_output_shares_one_recovery(monkeypatch, context, bad, code):
    seen = transport(monkeypatch, [response(bad), response()])
    _, usage = generate(context)
    assert len(seen) == 2 and usage["_generation"]["attempts"][0]["error_code"] == code
    assert usage["_generation"]["recovered"]


def test_bom_and_complete_fence_normalize_without_paid_recovery(monkeypatch, context):
    seen = transport(monkeypatch, [response(" \ufeff```json\n" + json.dumps(GOOD) + "\n``` ")])
    generate(context)
    assert len(seen) == 1


def test_syntax_and_length_share_maximum_two_calls_and_unknown_usage_is_not_zero(
    monkeypatch, context
):
    seen = transport(
        monkeypatch,
        [
            response("{", usage={"prompt_tokens": 5}),
            response("", "length", {"completion_tokens": 9}),
        ],
    )
    with pytest.raises(ai.AIError) as error:
        generate(context)
    assert len(seen) == 2 and error.value.code == "output_limit"
    assert error.value.pm_usage == {}
    assert not error.value.pm_generation["recovered"]
    assert [item["error_code"] for item in error.value.pm_generation["attempts"]] == [
        "model_output_format",
        "output_limit",
    ]


@pytest.mark.parametrize("kind", ["outside_evidence", "wrong_revision", "illegal_action"])
def test_semantic_violations_are_never_repaired(monkeypatch, context, kind):
    bad = copy.deepcopy(GOOD)
    if kind == "outside_evidence":
        bad["findings"] = [{"title": "bad", "detail": "bad", "evidence_ids": ["task:outside"]}]
    else:
        bad["draft_actions"] = [
            {
                "kind": "task_update",
                "task_id": "t1",
                "expected_revision": 999 if kind == "wrong_revision" else 4,
                "progress": 25,
                "reason": "测试",
                "evidence_ids": ["task:t1"],
            }
        ]
        if kind == "illegal_action":
            bad["draft_actions"][0]["kind"] = "delete_project"
    seen = transport(monkeypatch, [response(bad)])
    with pytest.raises(ai.AIError) as error:
        generate(context)
    assert len(seen) == 1 and not error.value.pm_generation["recovery_attempted"]


@pytest.mark.parametrize("finish", ["content_filter", "tool_calls"])
def test_non_answer_finish_reason_cannot_succeed_even_with_valid_json(monkeypatch, context, finish):
    seen = transport(monkeypatch, [response(finish=finish)])
    with pytest.raises(ai.AIError) as error:
        generate(context)
    assert len(seen) == 1 and error.value.code == "model_rejected"


def test_retry_checks_authorization_before_second_call(monkeypatch, context):
    seen = transport(monkeypatch, [response("", "length")])
    guards = []

    def before():
        guards.append(True)
        if len(guards) == 2:
            raise HTTPException(403, "权限已撤销")

    with pytest.raises(HTTPException) as error:
        generate(context, before_attempt=before)
    assert len(seen) == 1 and error.value.pm_generation["error_code"] == "authorization_changed"


@pytest.mark.parametrize("finish", ["stop", "length"])
def test_global_deadline_rejects_late_success_and_prevents_retry(monkeypatch, context, finish):
    clock = [0]
    monkeypatch.setattr(pm_ai_generation.time, "monotonic", lambda: clock[0])
    calls = []

    def late(*args, **kwargs):
        calls.append(True)
        clock[0] = 241
        return response(finish=finish)

    monkeypatch.setattr(ai, "request", late)
    with pytest.raises(ai.AIError) as error:
        generate(context)
    assert len(calls) == 1 and error.value.pm_generation["error_code"] == "generation_deadline"


@pytest.mark.parametrize("material", ["", "研发🙂" * 5000])
def test_ollama_preserves_schema_and_reserves_output_context(monkeypatch, context, material):
    context["material"] = material
    seen = transport(
        monkeypatch, [{"message": {"content": json.dumps(GOOD)}, "done_reason": "stop"}]
    )
    generate(context, provider="ollama", config={"model": "test-model"})
    body = seen[0]["body"]
    assert body["options"]["num_predict"] == 8192 and body["options"]["temperature"] == 0
    input_bytes = sum(len(x["content"].encode("utf-8")) for x in body["messages"])
    assert body["options"]["num_ctx"] == ((input_bytes + 8192 + 8191) // 8192) * 8192
    assert body["options"]["num_ctx"] <= 131072
    assert set(body["format"]["required"]) == {"summary", "findings", "draft_actions"}


@pytest.mark.parametrize("material", ["会" * 131072, "中🙂" * 18000])
def test_context_capacity_preflight_does_not_claim_a_model_call(monkeypatch, context, material):
    context["material"] = material
    seen = transport(monkeypatch, [])
    with pytest.raises(ai.AIError) as error:
        generate(context, provider="ollama", config={"model": "test-model"})
    assert not seen and error.value.code == "context_budget"
    assert error.value.pm_generation["attempts"] == []


def test_legacy_result_compatibility_does_not_weaken_new_generation_contract(context):
    assert pm_ai_runs.validate_result('{"summary":"旧记录"}', context)["findings"] == []
    with pytest.raises(ai.AIError) as error:
        pm_ai_runs.validate_result('{"summary":"新记录"}', context, require_complete=True)
    assert error.value.code == "model_output_format"


def test_diagnostic_allowlist_rejects_arbitrary_fields_and_unknown_numbers(monkeypatch, context):
    seen = transport(
        monkeypatch,
        [
            response(
                usage={
                    "completion_tokens": float("nan"),
                    "prompt_tokens": True,
                    "secret": "NEVER_STORE",
                    "completion_tokens_details": {"reasoning_tokens": "private"},
                }
            )
        ],
    )
    _, usage = generate(context)
    assert len(seen) == 1 and pm_ai_generation.counters(usage) == {}
    metadata = usage["_generation"]
    metadata["secret"] = "NEVER_STORE"
    metadata["attempts"][0]["private"] = "NEVER_STORE"
    safe = pm_ai_generation.safe_usage({**usage, "private": "NEVER_STORE"})
    assert "NEVER_STORE" not in json.dumps(safe)


@pytest.mark.parametrize("change", ["cancel", "permission", "permission_after_recovery"])
def test_worker_does_not_retry_or_save_result_after_cancel_or_role_change(
    client, auth_headers, project_factory, monkeypatch, live_ai_roles, change
):
    monkeypatch.setattr(
        ai, "load_settings", lambda db: {"provider": "deepseek", "providers": {"deepseek": CONFIG}}
    )
    pid = project_factory("t-admin")
    queued = client.post(
        "/api/v1/pm-ai/runs",
        headers=auth_headers,
        json={"scenario": "weekly", "project_ids": [pid]},
    ).json()
    with SessionLocal.begin() as db:
        db.get(PMAIRun, queued["id"]).workflow = None
    calls = []

    def call(*args, **kwargs):
        calls.append(True)
        if change == "permission_after_recovery" and len(calls) == 1:
            return response("", "length")
        with SessionLocal.begin() as db:
            if change == "cancel":
                db.get(PMAIRun, queued["id"]).state = "cancelled"
            else:
                db.get(User, "t-admin").is_active = False
        return response() if change == "permission_after_recovery" else response("", "length")

    monkeypatch.setattr(ai, "request", call)
    try:
        assert pm_ai_runs.process_one()
        with SessionLocal() as db:
            row = db.get(PMAIRun, queued["id"])
            assert row.state == ("cancelled" if change == "cancel" else "failed")
            assert row.result is None
            if change == "permission_after_recovery":
                metadata = pm_ai_runs.run_view(row)["generation"]
                assert (
                    metadata["error_code"] == "authorization_changed" and not metadata["recovered"]
                )
        assert len(calls) == (2 if change == "permission_after_recovery" else 1)
    finally:
        with SessionLocal.begin() as db:
            db.get(User, "t-admin").is_active = True
            db.query(PMAIRun).filter_by(id=queued["id"]).delete()


def test_worker_failed_attempts_retain_model_safe_usage_and_generation(
    client, auth_headers, project_factory, monkeypatch, live_ai_roles
):
    monkeypatch.setattr(
        ai, "load_settings", lambda db: {"provider": "deepseek", "providers": {"deepseek": CONFIG}}
    )
    pid = project_factory("t-admin")
    queued = client.post(
        "/api/v1/pm-ai/runs",
        headers=auth_headers,
        json={"scenario": "weekly", "project_ids": [pid]},
    ).json()
    with SessionLocal.begin() as db:
        db.get(PMAIRun, queued["id"]).workflow = None
    transport(
        monkeypatch,
        [
            response("", "length", {"completion_tokens": 5}),
            response("", "length", {"completion_tokens": 7}),
        ],
    )
    try:
        assert pm_ai_runs.process_one()
        result = client.get(f'/api/v1/pm-ai/runs/{queued["id"]}', headers=auth_headers).json()
        assert result["state"] == "failed" and result["provider"] == "deepseek"
        assert result["model"] == CONFIG["model"] and result["usage"] == {"completion_tokens": 12}
        assert result["generation"]["error_code"] == "output_limit"
        assert len(result["generation"]["attempts"]) == 2
        assert "NEVER_PERSIST" not in json.dumps(result)
    finally:
        with SessionLocal.begin() as db:
            db.query(PMAIRun).filter_by(id=queued["id"]).delete()
