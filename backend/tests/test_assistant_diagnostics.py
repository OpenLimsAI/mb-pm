"""Distinguish real failure boundaries without recording prompts, responses or credentials."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
import test_assistant
from fastapi import HTTPException

from app.services import ai
from app.services import assistant_diagnostics as diag
from app.services import assistant_tool_chat as runner

assistant_client = test_assistant.assistant_client
solution_client = test_assistant.solution_client
REAL_CHAT = ai.chat


@pytest.fixture
def events(monkeypatch):
    values = []
    monkeypatch.setattr(diag.LOGGER, "info", lambda encoded: values.append(json.loads(encoded)))
    return values


@pytest.mark.parametrize(
    "failure, code, status, expected",
    [
        (ai.AIError("SECRET", code="model_timeout"), "model_timeout", 504, "等待超时"),
        (ai.AIError("SECRET", code="output_limit"), "output_limit", 502, "输出上限"),
        (
            ai.AIError("SECRET", code="model_rate_limit", upstream_status=429),
            "model_rate_limit",
            503,
            "限流",
        ),
        (ai.AIError("SECRET", code="model_auth", upstream_status=401), "model_auth", 503, "权限"),
        (TimeoutError("SECRET"), "model_timeout", 504, "等待超时"),
        (ValueError("SECRET"), "model_invalid_response", 502, "格式"),
    ],
)
def test_failure_id_matches_logs_and_draft_is_not_saved(
    assistant_client, monkeypatch, events, failure, code, status, expected
):
    f = assistant_client
    task = test_assistant.create(f)
    request_id = str(uuid4())

    def fail(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(ai, "chat", fail)
    response = test_assistant.question(f, task, request_id=request_id, question="SECRET QUESTION")
    assert response.status_code == status and expected in response.json()["detail"]
    diagnostic_id = response.headers[diag.ID_HEADER]
    assert len(diagnostic_id) == 32 and diagnostic_id in response.json()["detail"]
    assert all(event["diagnostic_id"] == diagnostic_id for event in events)
    assert events[-1]["code"] == code and events[-1]["request_id"] == request_id
    assert events[-1]["stage"] == "model"
    assert "SECRET" not in response.text + json.dumps(events)
    assert f.client.get(f"{test_assistant.PREFIX}/{task['id']}").json() == task
    assert diag.CURRENT.get() is None


def test_finish_reason_and_usage_retain_evidence_for_output_limit(
    assistant_client, monkeypatch, events
):
    f = assistant_client

    def upstream(*_args, **_kwargs):
        diag.transport_status(200)
        return {
            "choices": [{"finish_reason": "length", "message": {"content": "SECRET ANSWER"}}],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 4096,
                "completion_tokens_details": {"reasoning_tokens": 4000},
            },
        }

    monkeypatch.setattr(
        ai,
        "chat",
        lambda provider, cfg, messages, **kw: REAL_CHAT(
            "deepseek", cfg, messages, request_fn=upstream, **kw
        ),
    )
    response = test_assistant.question(f, test_assistant.create(f))
    assert response.status_code == 502
    completed = next(e for e in events if e["event"] == "model_completed")
    assert completed["finish_reason"] == "length"
    assert completed["completion_tokens"] == 4096 and completed["reasoning_tokens"] == 4000
    assert completed["upstream_status"] == 200
    assert events[-1]["code"] == "output_limit"
    assert "SECRET ANSWER" not in json.dumps(events)


def test_success_and_retry_use_distinct_attempt_ids(assistant_client, events):
    f = assistant_client
    task = test_assistant.create(f)
    request_id = str(uuid4())
    first = test_assistant.question(f, task, request_id=request_id)
    second = test_assistant.question(f, task, request_id=request_id)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.headers[diag.ID_HEADER] != second.headers[diag.ID_HEADER]
    assert len(f.calls) == 1
    assert len([e for e in events if e["event"] == "request_completed"]) == 2
    assert {e["request_id"] for e in events} == {request_id}


def test_model_and_tool_metadata_does_not_log_data_or_untrusted_labels(monkeypatch, events):
    cfg = {"model": "https://private.test/?api_key=SECRET", "api_key": "SECRET"}
    calls = iter(
        [
            {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "SECRET",
                            "reasoning_content": "SECRET",
                            "tool_calls": [
                                {
                                    "id": "SECRET",
                                    "function": {
                                        "name": "read_page",
                                        "arguments": '{"path":"sources/SECRET.md"}',
                                    },
                                }
                            ],
                        },
                    }
                ]
            },
            {
                "choices": [{"finish_reason": "stop", "message": {"content": "SECRET RESULT"}}],
                "usage": {"completion_tokens": "SECRET", "prompt_tokens": True},
            },
        ]
    )
    monkeypatch.setattr(runner.solution_knowledge, "check_access", lambda claims: None)
    monkeypatch.setattr(runner.knowledge, "execute", lambda *args: {"body": "SECRET PAPER"})
    with diag.request_scope(uuid4()):
        diag.configure_model("custom", cfg)
        result = runner.chat(
            "custom",
            cfg,
            [{"role": "system", "content": "SECRET QUESTION"}],
            {},
            request_fn=lambda *a, **kw: next(calls),
        )
    assert result == "SECRET RESULT"
    assert events[-1]["model_rounds"] == 2 and events[-1]["tool_calls"] == 1
    assert any(e.get("tool") == "read_page" for e in events)
    assert all(e.get("model", "custom-model") == "custom-model" for e in events)
    encoded = json.dumps(events)
    assert "SECRET" not in encoded and "private.test" not in encoded
    assert (
        next(e for e in events if e["event"] == "model_completed").get("completion_tokens") is None
    )


def test_concurrent_requests_cannot_share_trace(events):
    barrier = Barrier(2)
    ids = [uuid4(), uuid4()]

    def run(request_id):
        with diag.request_scope(request_id):
            barrier.wait(timeout=3)
            diag.stage("saving")
        assert diag.CURRENT.get() is None

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(run, ids))
    for request_id in ids:
        rows = [e for e in events if e["request_id"] == str(request_id)]
        assert len({e["diagnostic_id"] for e in rows}) == 1
        assert rows[0]["event"] == "request_started" and rows[-1]["event"] == "request_completed"
    assert len({e["diagnostic_id"] for e in events}) == 2


def test_total_query_timeout_is_not_reported_as_model_timeout(monkeypatch, events):
    monkeypatch.setattr(runner, "MAX_SECONDS", 0)
    monkeypatch.setattr(runner.solution_knowledge, "check_access", lambda claims: None)
    with pytest.raises(HTTPException) as exc, diag.request_scope(uuid4()):
        runner.chat("deepseek", {"model": "test"}, [{"role": "system", "content": "s"}], {})
    assert exc.value.status_code == 504
    assert events[-1]["code"] == "query_timeout" and events[-1]["model_rounds"] == 0


def test_unexpected_exception_is_sanitized_and_context_resets(events):
    with pytest.raises(HTTPException) as exc, diag.request_scope(uuid4()):
        raise RuntimeError("SECRET SQL/KEY/PROMPT")
    assert exc.value.status_code == 500
    assert events[-1]["code"] == "unexpected_error"
    assert "SECRET" not in str(exc.value.detail) + json.dumps(events)
    assert diag.CURRENT.get() is None


@pytest.mark.parametrize("wrapped", [False, True])
def test_enterprise_transport_recognizes_socket_and_url_timeouts(monkeypatch, events, wrapped):
    import urllib.error

    failure = TimeoutError("SECRET")
    if wrapped:
        failure = urllib.error.URLError(failure)

    class Opener:
        def open(self, *a, **kw):
            raise failure

    monkeypatch.setattr(ai.urllib.request, "build_opener", lambda *a: Opener())
    with pytest.raises(HTTPException) as exc, diag.request_scope(uuid4()):
        try:
            diag.model_call(
                ai.request,
                "deepseek",
                {"base_url": "https://api.test", "api_key": "SECRET"},
                "/chat/completions",
                {},
                timeout=60,
            )
        except ai.NetworkError as error:
            assert error.code == "model_timeout"
            raise diag.model_http_error(error) from None
    assert exc.value.status_code == 504
    assert next(e for e in events if e["event"] == "model_failed")["code"] == "model_timeout"
    assert events[-1]["code"] == "model_timeout" and "SECRET" not in json.dumps(events)


def test_log_reader_filters_both_ids_and_only_outputs_diagnostic_fields():
    import subprocess
    import sys
    from pathlib import Path

    request_id, diagnostic_id = str(uuid4()), uuid4().hex
    row = {
        "event": "request_failed",
        "request_id": request_id,
        "diagnostic_id": diagnostic_id,
        "code": "output_limit",
        "prompt": "SECRET QUESTION",
        "api_key": "SECRET KEY",
    }
    other = {**row, "diagnostic_id": uuid4().hex, "request_id": str(uuid4())}
    script = Path(__file__).resolve().parents[2] / "scripts/read-assistant-diagnostics.py"
    for selected in (request_id, diagnostic_id):
        result = subprocess.run(
            [sys.executable, str(script), "--id", selected, "--failures"],
            input="HTTP Request: unrelated\n" + json.dumps(row) + "\n" + json.dumps(other),
            capture_output=True,
            text=True,
            check=True,
        )
        records = [json.loads(line) for line in result.stdout.splitlines()]
        assert len(records) == 1 and records[0]["code"] == "output_limit"
        assert "SECRET" not in result.stdout
