"""Phase-aware timeouts remain content-free and tied to the current model round."""

import json
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
import test_kimi_generation as kimi_wire
from fastapi import HTTPException

from app.services import ai
from app.services import assistant_diagnostics as diag
from app.services import assistant_generation as generation


@pytest.fixture
def events(monkeypatch):
    values = []
    monkeypatch.setattr(diag.LOGGER, "info", lambda value: values.append(json.loads(value)))
    return values


def success(*_args, **_kwargs):
    return {"choices": [{"message": {"content": "PRIVATE ANSWER"}, "finish_reason": "stop"}]}


def test_stream_and_reasoning_policy_with_phase_timings_never_log_content(events, monkeypatch):
    point = [10.0]
    monkeypatch.setattr(diag, "monotonic", lambda: point[0])

    def request(*_args, **_kwargs):
        diag.transport_event("connect")
        point[0] = 10.5
        diag.transport_event("response_headers", response_ms=500)
        point[0] = 10.6
        diag.transport_event("first_byte", first_byte_ms=600)
        diag.transport_event("first_reasoning")
        point[0] = 11.0
        diag.transport_event("first_content", last_data_age_ms=0)
        return success()

    with diag.request_scope(uuid4()):
        cfg = {"provider": "kimi", "model": "kimi-k3.1-pro", "api_key": "SECRET"}
        diag.configure_model("custom", cfg)
        diag.model_call(
            request,
            "custom",
            cfg,
            "/chat/completions",
            {
                "messages": [{"content": "PRIVATE QUESTION"}],
                "stream": True,
                "reasoning_effort": "low",
                "max_completion_tokens": 16384,
            },
            timeout=120,
        )
    started = next(row for row in events if row["event"] == "model_started")
    assert started["provider"] == "kimi" and started["stream"] is True
    assert started["reasoning_effort"] == "low" and started["output_budget"] == 16384
    completed = next(row for row in events if row["event"] == "model_completed")
    assert completed["response_ms"] == 500 and completed["first_byte_ms"] == 600
    assert completed["first_reasoning_ms"] == 600 and completed["first_content_ms"] == 1000
    assert completed["last_data_age_ms"] == 0
    assert "PRIVATE" not in json.dumps(events) and "SECRET" not in json.dumps(events)


@pytest.mark.parametrize("kind", sorted(diag.TIMEOUT_KINDS))
def test_timeout_categories_are_available_on_final_request_failure(events, kind):
    def request(*_args, **_kwargs):
        error = ai.AIError("SECRET TRANSPORT EXCEPTION", code="model_timeout")
        error.timeout_kind = kind
        error.timeout_phase = "response_headers"
        error.last_data_age_ms = 120000
        raise error

    with pytest.raises(HTTPException), diag.request_scope(uuid4()):
        try:
            diag.model_call(request, "kimi", {}, "/chat/completions", {}, timeout=120)
        except ai.AIError as exc:
            raise diag.model_http_error(exc) from None
    failed = next(row for row in events if row["event"] == "model_failed")
    assert failed["timeout_kind"] == kind and failed["transport_phase"] == "response_headers"
    assert failed["last_data_age_ms"] == 120000
    assert events[-1]["timeout_kind"] == kind
    assert events[-1]["code"] == "model_timeout" and "SECRET" not in json.dumps(events)


def test_monitor_can_record_total_timeout_before_transport_thread_ends(events):
    with pytest.raises(HTTPException), diag.request_scope(uuid4()):
        diag.transport_event("stream_idle", last_data_age_ms=5000, timeout_kind="total")
        raise diag.model_http_error(ai.AIError("TOTAL", code="model_timeout"))
    assert events[-1]["timeout_kind"] == "total"
    assert events[-1]["last_data_age_ms"] == 5000


@pytest.mark.parametrize("status", [408, 504])
def test_upstream_timeout_is_distinct_without_changing_public_timeout_code(events, status):
    def request(*_args, **_kwargs):
        diag.transport_status(status)
        raise ai.AIError(
            "PRIVATE UPSTREAM BODY", code=diag.upstream_code(status), upstream_status=status
        )

    with pytest.raises(HTTPException) as error, diag.request_scope(uuid4()):
        try:
            diag.model_call(request, "kimi", {}, "/chat/completions", {}, timeout=120)
        except ai.AIError as exc:
            raise diag.model_http_error(exc) from None
    assert error.value.headers[diag.ERROR_HEADER] == "model_timeout"
    failed = next(row for row in events if row["event"] == "model_failed")
    assert failed["upstream_status"] == status and failed["timeout_kind"] == "upstream_timeout"
    assert "PRIVATE" not in json.dumps(events)


def test_untrusted_metadata_is_ignored_and_rounds_do_not_inherit_old_timings(events):
    with diag.request_scope(uuid4()):

        def first(*_args, **_kwargs):
            diag.transport_event("response_headers", response_ms=10, timeout_kind="SECRET")
            diag.transport_event("https://SECRET", response_ms=20)
            diag.transport_event("first_byte", first_byte_ms="SECRET", last_data_age_ms=-1)
            return success()

        diag.model_call(
            first, "kimi", {}, "/chat/completions", {"reasoning_effort": {"SECRET": 1}}, timeout=120
        )
        diag.model_call(success, "kimi", {}, "/chat/completions", {}, timeout=120)
    completed = [row for row in events if row["event"] == "model_completed"]
    assert completed[0]["response_ms"] == 10
    assert "response_ms" not in completed[1] and "transport_phase" not in completed[1]
    assert "SECRET" not in json.dumps(events)


@pytest.mark.parametrize("effort", ["max", "UNKNOWN_PRIVATE_EFFORT"])
def test_reasoning_effort_is_allowlisted_instead_of_echoing_unrecognized_values(events, effort):
    with diag.request_scope(uuid4()):
        diag.model_call(
            success, "kimi", {}, "/chat/completions", {"reasoning_effort": effort}, timeout=120
        )
    started = next(row for row in events if row["event"] == "model_started")
    if effort == "max":
        assert started["reasoning_effort"] == "max"
    else:
        assert started["reasoning_effort"] is None and effort not in json.dumps(events)


def test_monitored_kimi_timeout_logs_original_cause_and_isolates_recovery_round(events, monkeypatch):
    waiting = kimi_wire.response(None, reasoning="PRIVATE REASONING", block=True)
    calls = kimi_wire.sequence(monkeypatch, [waiting, kimi_wire.response("PRIVATE ANSWER")])
    monkeypatch.setattr(generation, "FIRST_CONTENT_SECONDS", 0.03)
    monkeypatch.setattr(generation, "POLL_SECONDS", 0.005)
    with diag.request_scope(uuid4()), generation.run_context(lambda _: None):
        diag.configure_model("custom", kimi_wire.CFG)
        answer, _ = generation.call("custom", kimi_wire.CFG, kimi_wire.MESSAGES)
    assert answer == "PRIVATE ANSWER" and len(calls) == 2
    failed = [row for row in events if row["event"] == "model_failed"]
    assert len(failed) == 1 and failed[0]["round"] == 1
    assert failed[0]["code"] == "model_timeout"
    assert failed[0]["timeout_kind"] == "first_content"
    assert "first_reasoning_ms" in failed[0] and "last_data_age_ms" in failed[0]
    completed = next(row for row in events if row["event"] == "model_completed")
    assert completed["round"] == 2 and "timeout_kind" not in completed
    assert "first_reasoning_ms" not in completed
    assert any(row["event"] == "timeout_recovery_started" for row in events)
    assert events[-1]["event"] == "request_completed"
    assert "PRIVATE" not in json.dumps(events)
    assert kimi_wire.CFG["api_key"] not in json.dumps(events)


def test_reader_retains_transport_and_recovery_metadata_but_discards_content():
    ident, request = uuid4().hex, str(uuid4())
    records = [
        {
            "event": event,
            "diagnostic_id": ident,
            "request_id": request,
            "transport_phase": "first_reasoning",
            "timeout_kind": "first_content",
            "first_reasoning_ms": 1500,
            "stream": True,
            "reasoning_effort": "low",
            "thinking": "SECRET",
            "prompt": "SECRET",
            "url": "https://SECRET",
        }
        for event in ["model_transport", "timeout_recovery_started"]
    ]
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[2] / "scripts/read-assistant-diagnostics.py"),
            "--id",
            ident,
        ],
        input="\n".join(json.dumps(row) for row in records),
        capture_output=True,
        text=True,
        check=True,
    )
    returned = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(returned) == 2 and returned[0]["first_reasoning_ms"] == 1500
    assert returned[1]["event"] == "timeout_recovery_started" and "SECRET" not in result.stdout
