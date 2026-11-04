"""Kimi native streaming, bounded recovery and cancellation without external calls."""

import json
import threading
import time
from types import SimpleNamespace

import pytest
import test_assistant_generation as wire_tests
from fastapi import HTTPException

from app.services import ai
from app.services import assistant_generation as generation
from app.services import assistant_generation_policy as policy

CFG = {
    "provider": "kimi",
    "base_url": "https://api.moonshot.cn/v1",
    "model": "kimi-k3.1-pro",
    "api_key": "selected-kimi-fake-key",
}
MESSAGES = [{"role": "user", "content": "已查证公开资料[1]；请总结结论"}]
DONE = b"data: [DONE]\n\n"


def response(text="简洁结论[1]", *, reasoning=None, finish="stop", block=False):
    chunks = []
    if reasoning:
        chunks.append(wire_tests.event(reasoning=reasoning))
    if text is not None:
        chunks.extend([wire_tests.event(text, finish=finish), DONE])
    return wire_tests.Response(chunks, block=block)


def sequence(monkeypatch, outcomes, *, on_headers=None):
    """One new pinned socket per attempt; outcomes are responses or header errors."""
    connections = []
    pending = list(outcomes)

    class Connection:
        def __init__(self, host, port, address, *, timeout):
            assert pending, "unexpected extra billable model call"
            self.outcome = pending.pop(0)
            self.host, self.port, self.address, self.timeout = host, port, address, timeout
            self.sock = wire_tests.Socket()
            self.closed = False
            if isinstance(self.outcome, wire_tests.Response):
                self.outcome.socket = self.sock
            connections.append(self)

        def connect(self):
            pass

        def request(self, method, path, body, headers):
            self.method, self.path, self.body, self.headers = (
                method,
                path,
                json.loads(body),
                headers,
            )

        def getresponse(self):
            if on_headers:
                on_headers()
            if isinstance(self.outcome, Exception):
                raise self.outcome
            return self.outcome

        def close(self):
            self.closed = True

    monkeypatch.setattr(
        generation.solution_ai, "resolved_addresses", lambda *_a, **_kw: ["93.184.216.34"]
    )
    monkeypatch.setattr(generation.solution_ai, "PinnedHTTPSConnection", Connection)
    return connections


@pytest.mark.parametrize("host", ["api.moonshot.cn", "api.moonshot.ai"])
@pytest.mark.parametrize("provider", ["kimi", "custom"])
@pytest.mark.parametrize("model", ["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"])
@pytest.mark.parametrize("kind,effort", [("general", "low"), ("analysis", "high")])
def test_native_kimi_stream_uses_selected_region_and_visible_text_only(
    monkeypatch, host, provider, model, kind, effort
):
    cfg = {**CFG, "base_url": f"https://{host}/v1", "model": model}
    raw = (
        wire_tests.event(reasoning="SECRET_REASONING")
        + wire_tests.event("结果", finish="stop", usage={"completion_tokens": 25})
        + DONE
    )
    parsed = wire_tests.Response([raw[i : i + 7] for i in range(0, len(raw), 7)])
    calls = sequence(monkeypatch, [parsed])
    updates = []
    worker = threading.get_ident()

    def update(row):
        assert threading.get_ident() == worker
        updates.append(row)

    with generation.run_context(update):
        answer, usage = generation.call(provider, cfg, MESSAGES, kind=kind)
    assert answer == "结果" and usage == {"completion_tokens": 25}
    assert "SECRET" not in json.dumps(updates)
    assert any(row.get("partial_content") == "结果" for row in updates)
    call = calls[0]
    assert call.host == host and call.path == "/v1/chat/completions"
    assert call.headers["Authorization"] == "Bearer selected-kimi-fake-key"
    assert call.body["stream"] is True and call.body["stream_options"] == {"include_usage": True}
    assert call.body["max_completion_tokens"] == 16384
    assert call.body["reasoning_effort"] == effort
    assert not {"max_tokens", "thinking", "temperature"} & call.body.keys()
    assert cfg["model"] == model and parsed.closed and call.closed


@pytest.mark.parametrize(
    "url",
    [
        "http://api.moonshot.cn/v1",
        "https://api.moonshot.cn.evil.org/v1",
        "https://api.moonshot.cn./v1",
        "https://api.moonshot.cn:8443/v1",
        "https://secret@api.moonshot.cn/v1",
        "https://api.moonshot.cn/v1?",
        "https://api.moonshot.cn/v1#",
        "https://api.moonshot.cn/v1/tools",
        "https://api.moonshot.cn/v1//",
        "https://api.moonshot.cn/v1\\",
        "https://api.moonshot.cn/\nv1",
        "https://proxy.example/v1",
    ],
)
def test_other_addresses_do_not_gain_native_streaming_or_recovery(url):
    assert not policy.applies("kimi", {**CFG, "base_url": url})


@pytest.mark.parametrize(
    "provider,cfg",
    [
        ("custom", {**CFG, "provider": "custom"}),
        ("deepseek", CFG),
        ("kimi", {**CFG, "model": "kimi-unknown"}),
    ],
)
def test_unverified_provider_or_model_does_not_enable_native_streaming(provider, cfg):
    assert not policy.applies(provider, cfg)


def test_empty_header_timeout_recovers_once_with_same_model_and_evidence(monkeypatch):
    calls = sequence(monkeypatch, [TimeoutError("secret error"), response()])
    updates = []
    with generation.run_context(updates.append):
        result, _ = generation.call("custom", CFG, MESSAGES, kind="analysis")
    assert result == "简洁结论[1]" and len(calls) == 2
    assert calls[0].body["reasoning_effort"] == "high"
    assert calls[1].body["reasoning_effort"] == "low"
    assert calls[1].body["messages"][: len(MESSAGES)] == MESSAGES
    assert "简洁恢复" in calls[1].body["messages"][-1]["content"]
    for call in calls:
        assert call.body["model"] == CFG["model"] and call.host == "api.moonshot.cn"
        assert call.headers["Authorization"] == "Bearer " + CFG["api_key"]
        assert "tools" not in call.body and call.closed
    assert any(row.get("stage") == "recovering" for row in updates)


def test_second_timeout_is_terminal_not_an_unbounded_retry(monkeypatch):
    calls = sequence(monkeypatch, [TimeoutError(), TimeoutError()])
    with generation.run_context(lambda _: None), pytest.raises(ai.AIError) as exc:
        generation.call("kimi", CFG, MESSAGES)
    assert exc.value.code == "model_timeout" and len(calls) == 2
    assert all(call.closed for call in calls)


def test_insufficient_remaining_budget_does_not_start_recovery(monkeypatch):
    calls = sequence(monkeypatch, [TimeoutError()])
    with generation.run_context(lambda _: None, budget_seconds=10), pytest.raises(ai.AIError):
        generation.call("kimi", CFG, MESSAGES)
    assert len(calls) == 1


def test_cancellation_checkpoint_prevents_recovery_charge(monkeypatch):
    calls = sequence(monkeypatch, [TimeoutError()])

    def cancelled(row):
        if row.get("checkpoint"):
            raise HTTPException(409, "cancelled")

    with generation.run_context(cancelled), pytest.raises(HTTPException):
        generation.call("kimi", CFG, MESSAGES)
    assert len(calls) == 1


def test_reasoning_activity_without_answer_hits_first_content_deadline_and_recovers(monkeypatch):
    waiting = response(None, reasoning="SECRET_REASONING", block=True)
    calls = sequence(monkeypatch, [waiting, response()])
    monkeypatch.setattr(generation, "FIRST_CONTENT_SECONDS", 0.03)
    monkeypatch.setattr(generation, "POLL_SECONDS", 0.005)
    updates = []
    with generation.run_context(updates.append):
        result, _ = generation.call("kimi", CFG, MESSAGES)
    assert result == "简洁结论[1]" and len(calls) == 2
    assert waiting.closed and calls[0].sock.closed.is_set()
    assert "SECRET" not in json.dumps(updates)


def test_first_response_at_121_seconds_succeeds_under_separate_header_budget(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(generation, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    events = []
    monkeypatch.setattr(
        generation.diagnostics,
        "transport_event",
        lambda phase, **values: events.append((phase, values)),
    )
    calls = sequence(monkeypatch, [response()], on_headers=lambda: clock.__setitem__(0, 121.0))
    with generation.run_context(lambda _: None):
        assert generation.call("kimi", CFG, MESSAGES)[0] == "简洁结论[1]"
    assert len(calls) == 1 and 150 in calls[0].sock.timeouts
    assert ("response_headers", {"response_ms": 121000}) in events
    assert ("first_byte", {"first_byte_ms": 121000}) in events


def test_reasoning_heartbeats_cannot_extend_180_second_first_answer_budget(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(generation, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(generation, "POLL_SECONDS", 0.005)

    class Reasoning(wire_tests.Response):
        def read1(self, size):
            if self.chunks:
                clock[0] += 61
            return super().read1(size)

    waiting = Reasoning([wire_tests.event(reasoning="SECRET") for _ in range(3)], block=True)
    calls = sequence(monkeypatch, [waiting, response()])
    updates = []
    with generation.run_context(updates.append):
        answer, _ = generation.call("kimi", CFG, MESSAGES)
    assert answer == "简洁结论[1]" and len(calls) == 2 and clock[0] == 183
    assert "SECRET" not in json.dumps(updates)
    assert calls[0].closed and waiting.closed


def test_dns_wait_is_bounded_and_unstopped_old_thread_cannot_retry(monkeypatch):
    release, finished = threading.Event(), threading.Event()
    attempts = []

    def resolve(*_args, **_kwargs):
        attempts.append(1)
        release.wait(3)
        finished.set()
        return ["93.184.216.34"]

    monkeypatch.setattr(generation.solution_ai, "resolved_addresses", resolve)
    monkeypatch.setattr(generation, "CONNECT_SECONDS", 0.02)
    monkeypatch.setattr(generation, "POLL_SECONDS", 0.005)
    try:
        with generation.run_context(lambda _: None), pytest.raises(ai.AIError) as exc:
            generation.call("kimi", CFG, MESSAGES)
        assert exc.value.timeout_kind == "connect"
        assert not exc.value.stream_quiesced and attempts == [1]
    finally:
        release.set()
        assert finished.wait(1)


def test_visible_answer_then_idle_timeout_keeps_partial_without_replay(monkeypatch):
    class Interrupted(wire_tests.Response):
        def read1(self, size):
            if self.chunks:
                return super().read1(size)
            raise TimeoutError("private network detail")

    partial = Interrupted([wire_tests.event("已生成正文[1]")])
    calls = sequence(monkeypatch, [partial])
    updates = []
    with generation.run_context(updates.append), pytest.raises(ai.AIError) as exc:
        generation.call("kimi", CFG, MESSAGES)
    assert exc.value.timeout_kind == "stream_idle" and exc.value.visible_content == "已生成正文[1]"
    assert len(calls) == 1 and any(row.get("final_partial") for row in updates)
    assert partial.closed and "private network detail" not in json.dumps(updates)


def test_cancel_during_reasoning_stops_socket_without_retry(monkeypatch):
    waiting = response(None, reasoning="SECRET", block=True)
    calls = sequence(monkeypatch, [waiting])
    start = time.monotonic()
    monkeypatch.setattr(generation, "POLL_SECONDS", 0.005)

    def update(_row):
        if time.monotonic() - start > 0.03:
            raise HTTPException(409, "cancelled")

    with generation.run_context(update), pytest.raises(HTTPException):
        generation.call("kimi", CFG, MESSAGES)
    assert len(calls) == 1 and waiting.closed and calls[0].sock.closed.is_set()


def test_visible_partial_timeout_is_preserved_and_not_replayed(monkeypatch):
    partial = wire_tests.Response([wire_tests.event("已有正文[1]")], block=True)
    calls = sequence(monkeypatch, [partial])
    monkeypatch.setattr(generation, "POLL_SECONDS", 0.005)
    updates = []
    with (
        generation.run_context(updates.append, budget_seconds=0.04),
        pytest.raises(ai.AIError) as exc,
    ):
        generation.call("kimi", CFG, MESSAGES)
    assert exc.value.code == "model_timeout" and exc.value.timeout_kind == "total"
    assert exc.value.visible_content == "已有正文[1]"
    assert len(calls) == 1 and any(row.get("final_partial") for row in updates)
    assert partial.closed and calls[0].sock.closed.is_set()


def test_no_retry_for_auth_rate_limit_malformed_or_network_failure(monkeypatch):
    for outcome, code in [
        (OSError("network secret"), "model_network"),
        (wire_tests.Response([b"broken\n\n"]), "model_invalid_response"),
    ]:
        calls = sequence(monkeypatch, [outcome])
        with generation.run_context(lambda _: None), pytest.raises(ai.AIError) as exc:
            generation.call("kimi", CFG, MESSAGES)
        assert exc.value.code == code and len(calls) == 1
    for status in (401, 403, 429):
        outcome = response()
        outcome.status = status
        calls = sequence(monkeypatch, [outcome])
        with generation.run_context(lambda _: None), pytest.raises(ai.AIError):
            generation.call("kimi", CFG, MESSAGES)
        assert len(calls) == 1


def test_output_recovery_on_kimi_never_sends_disabled_thinking(monkeypatch):
    calls = sequence(monkeypatch, [response("开头", finish="length"), response("结尾")])
    with generation.run_context(lambda _: None):
        answer, _ = generation.call("kimi", CFG, MESSAGES)
    assert answer == "开头\n\n结尾" and len(calls) == 2
    assert calls[1].body["reasoning_effort"] == "low" and "thinking" not in calls[1].body
    assert calls[1].body["max_completion_tokens"] == 16384


def test_timeout_and_output_recovery_share_one_total_retry(monkeypatch):
    calls = sequence(monkeypatch, [TimeoutError(), response("草稿", finish="length")])
    with generation.run_context(lambda _: None), pytest.raises(ai.AIError) as exc:
        generation.call("kimi", CFG, MESSAGES)
    assert exc.value.code == "output_limit" and exc.value.visible_content == "草稿"
    assert len(calls) == 2


def test_total_budget_honors_configured_value_above_600_without_exceeding_schema_max():
    with generation.run_context(lambda _: None, budget_seconds=850):
        assert 849 < generation.CURRENT.get().deadline - time.monotonic() <= 850
    with generation.run_context(lambda _: None, budget_seconds=1000):
        assert 899 < generation.CURRENT.get().deadline - time.monotonic() <= 900


def test_kimi_ai_parameter_policy_has_explicit_deep_mode_and_no_medium():
    for kind, expected in (("general", "low"), ("analysis", "high")):
        body = {"temperature": 0.3, "max_tokens": 4096}
        ai.kimi_parameters("custom", CFG, body, kind=kind)
        assert body == {"max_completion_tokens": 16384, "reasoning_effort": expected}
