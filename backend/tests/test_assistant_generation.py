"""Slow/fragmented model contracts without paid or external requests."""

import json
import threading
import time

import pytest

from app.services import ai
from app.services import assistant_diagnostics as diagnostics
from app.services import assistant_generation as generation

CFG = {
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-v4-pro",
    "api_key": "test-selected-profile-key",
}
MESSAGES = [{"role": "user", "content": "分析问题"}]


def event(content=None, *, finish=None, reasoning=None, usage=None):
    delta = {}
    if content is not None:
        delta["content"] = content
    if reasoning is not None:
        delta["reasoning_content"] = reasoning
    row = {"choices": [{"delta": delta, "finish_reason": finish}]}
    if usage is not None:
        row["usage"] = usage
    return ("data: " + json.dumps(row, ensure_ascii=False) + "\n\n").encode()


class Socket:
    def __init__(self):
        self.timeouts = []
        self.closed = threading.Event()

    def settimeout(self, value):
        self.timeouts.append(value)

    def shutdown(self, _how):
        self.closed.set()

    def close(self):
        self.closed.set()


class Response:
    status = 200

    def __init__(self, chunks, block=False):
        self.chunks = list(chunks)
        self.closed = False
        self.block = block
        self.socket = None

    def read1(self, size):
        if self.chunks:
            chunk = self.chunks.pop(0)
            if len(chunk) > size:
                self.chunks.insert(0, chunk[size:])
            return chunk[:size]
        if self.block:
            assert self.socket.closed.wait(5), "cancellation did not close the socket"
            raise OSError("closed")
        return b""

    def close(self):
        self.closed = True


def stream(monkeypatch, chunks, *, status=200, block=False):
    response = Response(chunks, block=block)
    response.status = status
    connections, addresses = [], []

    class Connection:
        def __init__(self, host, port, address, *, timeout):
            self.host, self.port, self.address = host, port, address
            self.timeout = timeout
            self.sock = Socket()
            response.socket = self.sock
            self.request_data = None
            self.connected = False
            self.closed = False
            connections.append(self)

        def connect(self):
            self.connected = True

        def request(self, method, path, body, headers):
            self.request_data = (method, path, json.loads(body), headers)

        def getresponse(self):
            return response

        def close(self):
            self.closed = True

    def resolve(host, port):
        addresses.append((host, port))
        return ["93.184.216.34"]

    monkeypatch.setattr(generation.solution_ai, "resolved_addresses", resolve)
    monkeypatch.setattr(generation.solution_ai, "PinnedHTTPSConnection", Connection)
    return response, connections, addresses


def test_fragmented_sse_reports_only_visible_content_on_the_worker_thread(monkeypatch):
    raw = (
        b": keep-alive\r\n\r\n"
        + event(reasoning="NEVER DISPLAY OR STORE REASONING")
        + event("细胞活率")
        + event("与收获时间有关。", finish="stop", usage={"completion_tokens": 20})
        + b"data: [DONE]\n\n"
    )
    response, connections, addresses = stream(
        monkeypatch, [raw[i : i + 7] for i in range(0, len(raw), 7)]
    )
    original = dict(CFG)
    updates, threads = [], []

    def update(row):
        updates.append(row)
        threads.append(threading.get_ident())

    with generation.run_context(update):
        answer, usage = generation.call(
            "custom", CFG, MESSAGES, request_fn=generation.solution_ai.pinned_request
        )
    assert answer == "细胞活率与收获时间有关。" and usage == {"completion_tokens": 20}
    assert set(threads) == {threading.get_ident()}
    assert any(row.get("partial_content") == answer for row in updates)
    assert "NEVER" not in json.dumps(updates)
    assert addresses == [("api.deepseek.com", 443)]
    method, path, body, headers = connections[0].request_data
    assert method == "POST" and path == "/v1/chat/completions"
    assert headers["Authorization"] == "Bearer " + CFG["api_key"]
    assert body["stream"] is True and body["max_tokens"] == 8192
    assert body["reasoning_effort"] == "low" and body["stream_options"] == {"include_usage": True}
    assert connections[0].timeout <= 15 and max(connections[0].sock.timeouts) <= 120
    assert CFG == original and response.closed and connections[0].closed


def test_explicit_analysis_keeps_deeper_reasoning_with_a_bounded_budget(monkeypatch):
    _, connections, _ = stream(monkeypatch, [event("结论", finish="stop"), b"data: [DONE]\n\n"])
    with generation.run_context(lambda _row: None):
        assert generation.call("deepseek", CFG, MESSAGES, kind="analysis")[0] == "结论"
    body = connections[0].request_data[2]
    assert body["reasoning_effort"] == "high" and body["max_tokens"] == 16384


@pytest.mark.parametrize(
    "url",
    [
        "http://api.deepseek.com",
        "https://api.deepseek.com.evil.example",
        "https://example.org/v1",
        "https://secret@api.deepseek.com",
        "https://api.deepseek.com:8443",
        "https://api.deepseek.com/other",
        "https://api.deepseek.com?redirect=1",
        "https://api.deepseek.com/#fragment",
    ],
)
def test_vendor_tuning_does_not_apply_to_other_endpoints(url):
    assert not generation.official_deepseek({**CFG, "base_url": url})


def test_generic_model_keeps_selected_endpoint_and_existing_request_parameters(monkeypatch):
    cfg = {
        "base_url": "https://model.example/v1",
        "model": "custom-model",
        "api_key": "private-key",
    }
    captured = []
    response = Response(
        [
            json.dumps(
                {"choices": [{"message": {"content": "普通回答"}, "finish_reason": "stop"}]}
            ).encode()
        ]
    )

    def open_request(provider, selected, path, body, wire):
        captured.append((provider, selected, path, body))
        wire.install(response=response)

    monkeypatch.setattr(generation, "_enterprise_open", open_request)
    with generation.run_context(lambda _row: None):
        result = generation.call("openai", cfg, MESSAGES)
    assert result == ("普通回答", {}) and captured[0][1] is cfg
    assert captured[0][2] == "/chat/completions"
    assert captured[0][3] == {"model": "custom-model", "messages": MESSAGES, "stream": False}


def test_private_unofficial_endpoint_still_uses_validated_pinned_transport(monkeypatch):
    cfg = {
        "base_url": "https://model.example/v1",
        "model": "custom-model",
        "api_key": "selected-key",
    }
    called = []

    def resolve(host, port):
        called.append((host, port))
        raise ai.AIError("禁止访问", code="model_network")

    monkeypatch.setattr(generation.solution_ai, "resolved_addresses", resolve)
    with generation.run_context(lambda _row: None), pytest.raises(ai.AIError) as error:
        generation.call("custom", cfg, MESSAGES, request_fn=generation.solution_ai.pinned_request)
    assert error.value.code == "model_network" and called == [("model.example", 443)]


@pytest.mark.parametrize(
    "chunks, code",
    [
        ([event("部分内容", finish="length"), b"data: [DONE]\n\n"], "output_limit"),
        ([event("部分内容", finish="stop")], "model_invalid_response"),
        ([event("部分内容"), b"data: [DONE]\n\n"], "model_invalid_response"),
        ([event(42), b"data: [DONE]\n\n"], "model_invalid_response"),
        ([event("", finish="stop"), b"data: [DONE]\n\n"], "model_empty_response"),
        ([event("部分内容", finish="aborted"), b"data: [DONE]\n\n"], "model_rejected"),
    ],
)
def test_incomplete_or_limited_stream_is_never_returned_as_a_completed_answer(
    monkeypatch, chunks, code
):
    response, _, _ = stream(monkeypatch, chunks)
    updates = []
    with generation.run_context(updates.append), pytest.raises(ai.AIError) as error:
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == code and response.closed
    if chunks[0] == event("部分内容", finish="length"):
        assert any(row.get("partial_content") == "部分内容" for row in updates)


@pytest.mark.parametrize(
    "status, code", [(401, "model_auth"), (429, "model_rate_limit"), (503, "model_rejected")]
)
def test_upstream_failure_preserves_safe_category_and_closes_connection(monkeypatch, status, code):
    response, connections, _ = stream(monkeypatch, [], status=status)
    with generation.run_context(lambda _row: None), pytest.raises(ai.AIError) as error:
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == code and error.value.upstream_status == status
    assert response.closed and connections[0].closed


def test_worker_lease_cancellation_aborts_a_blocked_network_read(monkeypatch):
    response, connections, _ = stream(monkeypatch, [], block=True)
    updates = []

    class LostLeaseError(Exception):
        pass

    def update(row):
        updates.append(row)
        if len(updates) >= 5:
            raise LostLeaseError()

    started = time.monotonic()
    with pytest.raises(LostLeaseError), generation.run_context(update):
        generation.call("deepseek", CFG, MESSAGES)
    assert time.monotonic() - started < 2
    assert connections[0].sock.closed.is_set() and response.closed


def test_total_deadline_cancels_even_if_socket_itself_has_not_timed_out(monkeypatch):
    response, connections, _ = stream(monkeypatch, [], block=True)
    started = time.monotonic()
    with (
        generation.run_context(lambda _row: None, budget_seconds=1),
        pytest.raises(ai.AIError) as error,
    ):
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == "model_timeout"
    assert time.monotonic() - started < 2
    assert connections[0].sock.closed.is_set() and response.closed


def test_answer_can_complete_after_sixty_seconds_without_weakening_total_deadline(monkeypatch):
    now = [0.0]
    response, _, _ = stream(
        monkeypatch, [event("答案"), event("完成", finish="stop"), b"data: [DONE]\n\n"]
    )
    original = response.read1

    def read(size):
        now[0] += 25
        return original(size)

    response.read1 = read
    monkeypatch.setattr(generation.time, "monotonic", lambda: now[0])
    with generation.run_context(lambda _row: None, budget_seconds=300):
        assert generation.call("deepseek", CFG, MESSAGES)[0] == "答案完成"
    assert now[0] == 75


def test_diagnostics_record_output_budget_first_content_and_usage_without_text(monkeypatch):
    stream(
        monkeypatch,
        [
            event("PRIVATE ANSWER", finish="stop", usage={"completion_tokens": 8}),
            b"data: [DONE]\n\n",
        ],
    )
    records = []
    attempt = diagnostics.Attempt("00000000-0000-4000-8000-000000000001")
    attempt.emit = lambda event, **fields: records.append({"event": event, **fields})
    token = diagnostics.CURRENT.set(attempt)
    try:
        with generation.run_context(lambda _row: None):
            generation.call("deepseek", CFG, MESSAGES)
    finally:
        diagnostics.CURRENT.reset(token)
    assert next(row for row in records if row["event"] == "model_started")["output_budget"] == 8192
    assert (
        next(row for row in records if row["event"] == "model_completed")["completion_tokens"] == 8
    )
    assert len([row for row in records if row["event"] == "model_first_content"]) == 1
    assert "PRIVATE ANSWER" not in json.dumps(records) and CFG["api_key"] not in json.dumps(records)


def test_no_context_keeps_existing_sync_contract(monkeypatch):
    called = []
    monkeypatch.setattr(
        ai, "chat", lambda *args, **kwargs: called.append((args, kwargs)) or ("旧接口", {})
    )
    assert not generation.active()
    assert generation.call("deepseek", CFG, MESSAGES) == ("旧接口", {})
    assert called[0][1] == {"timeout": 60, "request_fn": None}


@pytest.mark.parametrize(
    "provider, base_url",
    [("ollama", "http://127.0.0.1:11434"), ("openai", "https://gateway.example/v1")],
)
def test_enterprise_transport_tracks_connections_preserves_proxy_policy_and_bounds_io(
    monkeypatch, provider, base_url
):
    response = Response([b'{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}'])
    handlers_seen, requests_seen, connections = [], [], []

    def connect(connection):
        connection.sock = Socket()
        connections.append(connection)

    monkeypatch.setattr(generation.http.client.HTTPConnection, "connect", connect)
    monkeypatch.setattr(generation.http.client.HTTPSConnection, "connect", connect)

    class Opener:
        def open(self, req, timeout):
            requests_seen.append((req, timeout))
            handler_type = (
                generation.urllib.request.HTTPSHandler
                if base_url.startswith("https:")
                else generation.urllib.request.HTTPHandler
            )
            handler = next(h for h in handlers_seen if isinstance(h, handler_type))

            def do_open(cls, request, **_kwargs):
                connection = cls(request.host, timeout=timeout)
                connection.connect()
                return response

            handler.do_open = do_open
            return (
                handler.https_open(req) if base_url.startswith("https:") else handler.http_open(req)
            )

    def opener(*handlers):
        handlers_seen.extend(handlers)
        return Opener()

    monkeypatch.setattr(generation.urllib.request, "build_opener", opener)
    cfg = {"base_url": base_url, "model": "generic-model", "api_key": "chosen-key"}
    if provider == "ollama":
        response.chunks = [b'{"message":{"content":"ok"},"done_reason":"stop"}']
    with generation.run_context(lambda _row: None):
        assert generation.call(provider, cfg, MESSAGES)[0] == "ok"
    assert connections[0].timeout <= 15 and connections[0].sock is None  # Closed by transport.
    assert any(isinstance(h, ai.NoRedirect) for h in handlers_seen)
    proxies = [h for h in handlers_seen if isinstance(h, generation.urllib.request.ProxyHandler)]
    if provider == "ollama":
        assert proxies and proxies[0].proxies == {}
        assert requests_seen[0][0].get_header("Authorization") is None
    else:
        assert not proxies  # build_opener supplies the existing environment proxy handler.
        assert requests_seen[0][0].get_header("Authorization") == "Bearer chosen-key"


def test_json_tool_round_is_monitored_and_does_not_duplicate_model_diagnostics(monkeypatch):
    response = Response(
        [b'{"choices":[{"message":{"tool_calls":[]},"finish_reason":"tool_calls"}]}']
    )
    calls = []

    def opening(provider, cfg, path, body, wire):
        calls.append((path, body))
        wire.install(response=response)

    monkeypatch.setattr(generation, "_enterprise_open", opening)
    body = {
        "model": "generic",
        "messages": MESSAGES,
        "tools": [{"type": "function"}],
        "stream": False,
    }
    with generation.run_context(lambda _row: None):
        row = generation.request(
            "openai", {"base_url": "https://gateway.example"}, "/chat/completions", body
        )
    assert row["choices"][0]["finish_reason"] == "tool_calls"
    assert calls == [("/chat/completions", body)]


@pytest.mark.parametrize(
    "content,code", [("过" * 101, "response_too_large"), ("ok", "response_too_large")]
)
def test_stream_byte_and_content_budgets_are_enforced(monkeypatch, content, code):
    if len(content) > 100:
        monkeypatch.setattr(generation, "MAX_CONTENT", 100)
    else:
        monkeypatch.setattr(generation, "MAX_BYTES", 10)
    response, _, _ = stream(monkeypatch, [event(content, finish="stop"), b"data: [DONE]\n\n"])
    with generation.run_context(lambda _row: None), pytest.raises(ai.AIError) as error:
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == code and response.closed


@pytest.mark.parametrize("budget", [0, -1, float("nan"), float("inf")])
def test_invalid_total_budget_never_starts_a_transport(budget):
    with (
        pytest.raises(ValueError),
        generation.run_context(lambda _row: None, budget_seconds=budget),
    ):
        pytest.fail("invalid context started")


def test_output_limit_flushes_last_visible_fragment_and_never_reasoning(monkeypatch):
    stream(
        monkeypatch,
        [
            event("<think>SECRET-REASONING</think>前段"),
            event("最后一段", finish="length"),
            b"data: [DONE]\n\n",
        ],
    )
    writes = []
    with pytest.raises(ai.AIError) as error, generation.run_context(writes.append):
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == "output_limit"
    assert writes[-1] == {"final_partial": True, "partial_content": "前段最后一段"}
    assert "SECRET" not in str(writes)


def test_partial_flush_failure_never_hides_original_model_error(monkeypatch):
    stream(monkeypatch, [event("可见内容", finish="length"), b"data: [DONE]\n\n"])

    def update(fields):
        if fields.get("final_partial"):
            raise RuntimeError("cancelled token")

    with pytest.raises(ai.AIError) as error, generation.run_context(update):
        generation.call("deepseek", CFG, MESSAGES)
    assert error.value.code == "output_limit"
