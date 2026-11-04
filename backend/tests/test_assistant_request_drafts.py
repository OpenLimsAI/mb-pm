"""Draft eligibility and bounded context keep explicit recovery truthful."""

import json
from datetime import UTC, datetime, timedelta
from threading import Event

import pytest
import test_assistant
import test_assistant_requests_security as helpers
from fastapi import HTTPException

from app.models.assistant import AssistantRequest, AssistantTask
from app.services import ai, assistant_generation, assistant_requests

assistant_client = test_assistant.assistant_client
solution_client = test_assistant.solution_client
PREFIX = test_assistant.PREFIX


def saved_draft(f, status="failed", content="已生成的未完成草稿", *, payload_present=True):
    task = test_assistant.create(f)
    body = helpers.payload(task)
    assert helpers.submit(f, task, body).status_code == 202
    job = helpers.request_row(f, task, body["request_id"])
    job.status, job.partial_content = status, content
    if not payload_present:
        job.payload = {}
    if status in {"failed", "cancelled", "completed"}:
        f.db.get(AssistantTask, task["id"]).active_request_id = None
    f.db.commit()
    return task, body


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_retired_payload_cannot_advertise_or_start_draft_recovery(assistant_client, status):
    f = assistant_client
    task, body = saved_draft(f, status, payload_present=False)
    response = helpers.status(f, task, body["request_id"])
    assert response.status_code == 200
    assert response.json()["payload_expired"] is True
    assert response.json()["can_continue"] is False
    continuation = helpers.payload(task, continue_from_request=body["request_id"])
    rejected = helpers.submit(f, task, continuation)
    assert rejected.status_code == 422
    assert "没有可继续" in rejected.json()["detail"]
    assert f.calls == []


@pytest.mark.parametrize("status", ["queued", "running", "completed", "failed", "cancelled"])
@pytest.mark.parametrize("content", ["", "可供重新整理的草稿"])
def test_only_terminal_incomplete_requests_with_content_offer_recovery(
    assistant_client, status, content
):
    f = assistant_client
    task, body = saved_draft(f, status, content)
    response = helpers.status(f, task, body["request_id"])
    assert response.status_code == 200
    assert response.json()["can_continue"] is bool(content and status in {"failed", "cancelled"})


@pytest.mark.parametrize("length", [16000, 16001, 80000])
def test_recovered_prompt_preserves_short_draft_or_marks_omitted_middle(
    assistant_client, monkeypatch, length
):
    f = assistant_client
    content = "草稿开头" + "中" * (length - 8) + "草稿末尾"
    assert len(content) == length
    task, body = saved_draft(f, content=content)
    continuation = helpers.payload(task, continue_from_request=body["request_id"])
    assert helpers.submit(f, task, continuation).status_code == 202
    row = helpers.request_row(f, task, continuation["request_id"])
    chosen = assistant_requests.claim(f.db, row.id)
    prompts = []

    def model(_provider, _config, messages, **_kwargs):
        prompts.append(json.loads(messages[-1]["content"]))
        return "重新整理后的完整回答", {}

    monkeypatch.setattr(assistant_generation, "call", model)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f))
    state = helpers.status(f, task, continuation["request_id"]).json()
    assert state["status"] == "completed"
    draft = json.loads(prompts[0]["unfinished_draft"])
    assert draft["original_question"] == body["question"]
    assert draft["original_chars"] == length
    assert "不能将草稿当作新证据" in draft["instruction"]
    if length <= assistant_requests.DRAFT_CONTEXT_CHARS:
        assert draft["unfinished_content"] == content
        assert draft["truncated"] is False and draft["omitted_chars"] == 0
    else:
        assert len(draft["unfinished_content"]) == assistant_requests.DRAFT_CONTEXT_CHARS
        assert draft["unfinished_content"].startswith("草稿开头")
        assert draft["unfinished_content"].endswith("草稿末尾")
        assert "草稿中段已省略" in draft["unfinished_content"]
        assert draft["truncated"] is True and draft["omitted_chars"] > 0
        assert "不要推断被省略" in draft["instruction"]
    detail = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert detail["artifacts"][0]["content"] == "重新整理后的完整回答"


@pytest.mark.parametrize("interruption", ["expired-lease", "worker-stop"])
def test_internal_worker_interruption_retains_saved_draft_and_fences_late_answer(
    assistant_client, monkeypatch, interruption
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    chosen = helpers.claimed(f, task, body)
    stop = Event()

    def model(*_args, **_kwargs):
        assistant_generation.progress(stage="generating", partial_content="中断前已保存的安全草稿")
        if interruption == "expired-lease":
            job = helpers.request_row(f, task, body["request_id"])
            job.lease_until = datetime.now(UTC) - timedelta(seconds=1)
            f.db.commit()
        else:
            stop.set()
        return "LATE-ANSWER-MUST-NOT-BE-PUBLISHED", {}

    monkeypatch.setattr(assistant_generation, "call", model)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f), stop=stop)
    response = helpers.status(f, task, body["request_id"])
    assert response.status_code == 200
    state = response.json()
    assert state["status"] == "failed" and state["error_code"] == "request_interrupted"
    assert state["partial_content"] == "中断前已保存的安全草稿" and state["can_continue"] is True
    detail = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert detail["revision"] == task["revision"]
    assert detail["messages"] == detail["artifacts"] == []
    assert f.db.get(AssistantTask, task["id"]).active_request_id is None


@pytest.mark.parametrize("status", [403, 409])
def test_unmarked_permission_or_conflict_failure_does_not_retain_draft(
    assistant_client, monkeypatch, status
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    chosen = helpers.claimed(f, task, body)

    def model(*_args, **_kwargs):
        assistant_generation.progress(stage="generating", partial_content="不应保留的失败草稿")
        raise HTTPException(status, "权限或版本校验未通过")

    monkeypatch.setattr(assistant_generation, "call", model)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f))
    state = helpers.status(f, task, body["request_id"]).json()
    assert state["status"] == "failed" and state["error_code"] == "request_failed"
    assert state["partial_content"] == "" and state["can_continue"] is False


@pytest.mark.parametrize("interruption", ["cancel", "expired-lease"])
def test_output_recovery_forces_worker_fence_check_after_recent_partial_write(
    assistant_client, monkeypatch, interruption
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    chosen = helpers.claimed(f, task, body)
    cfg = {
        "model": "deepseek-v4-pro",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "isolated-test",
    }
    monkeypatch.setattr(
        ai, "load_settings", lambda: {"provider": "deepseek", "providers": {"deepseek": cfg}}
    )
    calls = []
    interrupted = False
    original_progress = assistant_requests.progress

    def progress(**fields):
        nonlocal interrupted
        original_progress(**fields)
        if fields.get("final_partial") and not interrupted:
            interrupted = True
            if interruption == "cancel":
                response = f.client.post(
                    f"{PREFIX}/{task['id']}/requests/{body['request_id']}/cancel"
                )
                assert response.status_code == 200 and response.json()["status"] == "cancelled"
            else:
                job = helpers.request_row(f, task, body["request_id"])
                job.lease_until = datetime.now(UTC) - timedelta(seconds=1)
                f.db.commit()

    def stream(_provider, _config, _path, request_body, wire, _kind):
        calls.append(request_body)
        wire.publish("content", "达到上限前已保存的草稿")
        return {
            "choices": [
                {"message": {"content": "达到上限前已保存的草稿"}, "finish_reason": "length"}
            ],
            "usage": {},
        }

    monkeypatch.setattr(assistant_requests, "progress", progress)
    monkeypatch.setattr(assistant_generation, "_stream_request", stream)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f))
    assert interrupted is True and len(calls) == 1
    state = helpers.status(f, task, body["request_id"]).json()
    assert state["status"] == ("cancelled" if interruption == "cancel" else "failed")
    assert state["error_code"] == (
        "request_cancelled" if interruption == "cancel" else "request_interrupted"
    )
    assert state["partial_content"] == "达到上限前已保存的草稿"
    detail = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert detail["messages"] == detail["artifacts"] == []
    assert detail["revision"] == task["revision"]


@pytest.mark.parametrize(
    "error_code", ["model_auth", "model_rate_limit", "model_rejected", "model_empty_response"]
)
def test_failed_automatic_recovery_keeps_saved_draft_and_reports_upstream_error(
    assistant_client, monkeypatch, error_code
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    chosen = helpers.claimed(f, task, body)
    cfg = {
        "model": "deepseek-v4-pro",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "isolated-test",
    }
    monkeypatch.setattr(
        ai,
        "load_settings",
        lambda: {"provider": "deepseek", "providers": {"deepseek": cfg}},
    )
    factory = helpers.factory_for(f)
    calls = []

    def stream(_provider, _config, _path, request_body, wire, _kind):
        calls.append(request_body)
        if len(calls) == 2:
            with factory() as db:
                assert db.get(AssistantRequest, chosen[0]).stage == "recovering"
            if error_code == "model_empty_response":
                return {
                    "choices": [{"message": {"content": ""}, "finish_reason": "stop"}],
                    "usage": {},
                }
            raise ai.AIError("SECRET-UPSTREAM-DETAIL", code=error_code)
        wire.publish("content", "自动恢复前已保存的安全草稿")
        return {
            "choices": [
                {
                    "message": {"content": "自动恢复前已保存的安全草稿"},
                    "finish_reason": "length",
                }
            ],
            "usage": {},
        }

    monkeypatch.setattr(assistant_generation, "_stream_request", stream)
    assistant_requests.execute(*chosen, factory=factory)
    assert len(calls) == 2
    response = helpers.status(f, task, body["request_id"])
    state = response.json()
    assert state["status"] == "failed" and state["error_code"] == error_code
    assert state["partial_content"] == "自动恢复前已保存的安全草稿"
    assert state["can_continue"] is True
    assert "SECRET" not in response.text
    detail = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert detail["messages"] == detail["artifacts"] == []
    assert detail["revision"] == task["revision"]


def test_oversized_automatic_recovery_preserves_persisted_prefix_without_artifact(
    assistant_client, monkeypatch
):
    f = assistant_client
    task = test_assistant.create(f)
    body = helpers.payload(task)
    chosen = helpers.claimed(f, task, body)
    cfg = {"model": "deepseek-v4-pro", "base_url": "https://api.deepseek.com/v1", "api_key": "test"}
    monkeypatch.setattr(
        ai, "load_settings", lambda: {"provider": "deepseek", "providers": {"deepseek": cfg}}
    )
    calls = []
    prefix = "A" * 79999

    def stream(_p, _c, _path, request_body, wire, _kind):
        calls.append(request_body)
        content = prefix if len(calls) == 1 else "BB"
        wire.publish("content", content)
        return {
            "choices": [
                {
                    "message": {"content": content},
                    "finish_reason": "length" if len(calls) == 1 else "stop",
                }
            ],
            "usage": {},
        }

    monkeypatch.setattr(assistant_generation, "_stream_request", stream)
    assistant_requests.execute(*chosen, factory=helpers.factory_for(f))
    state = helpers.status(f, task, body["request_id"]).json()
    assert len(calls) == 2 and state["status"] == "failed"
    assert state["error_code"] == "response_too_large"
    assert state["partial_content"] == prefix and state["can_continue"] is True
    detail = f.client.get(f"{PREFIX}/{task['id']}").json()
    assert detail["messages"] == detail["artifacts"] == []
