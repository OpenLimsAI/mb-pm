"""Bounded, cancellable generation for persisted personal-assistant requests.

The job worker owns the progress callback. Network I/O runs in a monitored thread;
callbacks (and therefore job leases/database writes) stay on the calling thread.
One bounded same-model recovery may follow an empty timeout or output limit.
No model fallback, credentials or reasoning text are exposed.
"""

import codecs
import http.client
import json
import math
import queue
import socket
import threading
import time
import urllib.error
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from dataclasses import dataclass
from urllib.parse import urlsplit

from app.schemas.model_network import enterprise_url, internal_approved
from app.services import ai, solution_ai
from app.services import assistant_diagnostics as diagnostics
from app.services import assistant_generation_policy as policy

CONNECT_SECONDS = 15
FIRST_RESPONSE_SECONDS = 150
IDLE_SECONDS = 120
FIRST_CONTENT_SECONDS = 180
RECOVERY_MIN_SECONDS = 60
MAX_BYTES = 2_000_000
MAX_CONTENT = 80_000
POLL_SECONDS = 0.5
CURRENT = ContextVar("assistant_generation", default=None)


@dataclass
class Generation:
    callback: object
    deadline: float
    output_recoveries: int = 0
    timeout_recoveries: int = 0


@contextmanager
def run_context(callback, budget_seconds=300):
    seconds = float(budget_seconds)
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("Generation budget must be a positive finite number")
    seconds = min(900, seconds)
    token = CURRENT.set(Generation(callback, time.monotonic() + seconds))
    try:
        guard()
        yield
    finally:
        CURRENT.reset(token)


def active():
    return CURRENT.get() is not None


def progress(**fields):
    state = CURRENT.get()
    if state is not None:
        state.callback(fields)


def guard():
    state = CURRENT.get()
    if state is not None:
        state.callback({})
        _remaining(state)


def checkpoint():
    """Force a fresh job fence check before another chargeable model request."""
    state = CURRENT.get()
    if state is not None:
        state.callback({"checkpoint": True})
        _remaining(state)


def _remaining(state):
    remaining = state.deadline - time.monotonic()
    if remaining <= 0:
        raise _timeout("total")
    return remaining


def _timeout(kind):
    error = ai.AIError("模型等待达到本轮时限", code="model_timeout")
    error.timeout_kind = kind
    return error


official_deepseek = policy.official_deepseek


def claim_output_recovery(provider, cfg):
    """One recovery for the whole durable run, within its original deadline."""
    if not policy.applies(provider, cfg):
        return False
    checkpoint()
    state = CURRENT.get()
    if (
        state is None
        or state.output_recoveries
        or state.timeout_recoveries
        or _remaining(state) < 15
    ):
        return False
    state.output_recoveries += 1
    trace = diagnostics.CURRENT.get()
    if trace is not None:
        trace.emit("output_recovery_started")
    return True


def claim_timeout_recovery(provider, cfg, error):
    # Only the known official streaming contract can be replayed; a stuck old
    # transport, any visible answer or exhausted total budget cannot be retried.
    state = CURRENT.get()
    if (
        state is None
        or not policy.kimi(provider, cfg)
        or state.output_recoveries
        or state.timeout_recoveries
        or getattr(error, "visible_content", "")
        or not getattr(error, "stream_quiesced", False)
        or getattr(error, "timeout_kind", None)
        not in {"connect", "response_headers", "stream_idle", "first_content", "upstream_timeout"}
    ):
        return False
    checkpoint()
    if _remaining(state) < RECOVERY_MIN_SECONDS:
        return False
    state.timeout_recoveries += 1
    trace = diagnostics.CURRENT.get()
    if trace is not None:
        trace.emit("timeout_recovery_started")
    return True


class _StoppedError(Exception):
    pass


class _Wire:
    def __init__(self, state):
        self.state = state
        self.events = queue.Queue(maxsize=128)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.connection = None
        self.response = None
        self.response_at = None
        self.abort_error = None
        self.phase = "connect"
        self.started = time.monotonic()
        self.phase_started_at = self.started
        self.last_data_at = None
        self.first_byte = False
        self.body_phase = "json_body"

    def phase_started(self, phase):
        self.phase = phase
        self.phase_started_at = time.monotonic()
        diagnostics.transport_event(phase)

    def received(self, chunk):
        if not chunk:
            return
        self.last_data_at = time.monotonic()
        if not self.first_byte:
            self.first_byte = True
            diagnostics.transport_event(
                "first_byte", first_byte_ms=round((self.last_data_at - self.started) * 1000)
            )

    def publish(self, kind, value):
        while not self.stop.is_set():
            try:
                self.events.put((kind, value), timeout=POLL_SECONDS)
                return
            except queue.Full:
                pass
        raise _StoppedError()

    def install(self, *, connection=None, response=None):
        with self.lock:
            if connection is not None:
                self.connection = connection
            if response is not None:
                self.response = response
                self.response_at = time.monotonic()
        if self.stop.is_set():
            self.abort()
            raise _StoppedError()

    def abort(self):
        self.stop.set()
        with self.lock:
            connection, response = self.connection, self.response
        sock = getattr(connection, "sock", None) or _response_socket(response)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        # Shutdown first unblocks the reader; close is performed in its finally.
        if connection is not None and sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def timeout(self, limit):
        if self.stop.is_set():
            raise _StoppedError()
        return min(limit, _remaining(self.state))

    def response_timeout(self):
        remaining = FIRST_RESPONSE_SECONDS - (time.monotonic() - self.started)
        if remaining <= 0:
            raise _timeout("response_headers")
        return self.timeout(remaining)


def _response_socket(response):
    raw = getattr(getattr(response, "fp", None), "raw", None)
    return getattr(raw, "_sock", None)


def _visible(content):
    return policy.visible(content)


def _monitor(work, *, content=False, prefix="", first_content_limit=None):
    state = CURRENT.get()
    if state is None:
        raise RuntimeError("Generation context is required")
    wire = _Wire(state)
    context = copy_context()

    def target():
        try:
            wire.publish("result", work(wire))
        except Exception as exc:
            if not wire.stop.is_set():
                try:
                    wire.publish("error", exc)
                except _StoppedError:
                    pass

    thread = threading.Thread(target=lambda: context.run(target), daemon=True)
    stage = "recovering" if state.output_recoveries or state.timeout_recoveries else "waiting_model"
    text, first = "", bool(prefix)
    last_safe_visible = prefix if len(prefix) <= MAX_CONTENT else ""
    started = wire.started
    failure = None
    progress(stage=stage)
    thread.start()
    try:
        while True:
            guard()
            try:
                kind, value = wire.events.get(timeout=min(POLL_SECONDS, _remaining(state)))
            except queue.Empty:
                now = time.monotonic()
                if (
                    wire.phase in {"connect", "request"}
                    and now - wire.phase_started_at >= CONNECT_SECONDS
                ):
                    raise _timeout(wire.phase) from None
                if wire.response is None and now - started >= FIRST_RESPONSE_SECONDS:
                    raise _timeout("response_headers") from None
                last_activity = (
                    wire.last_data_at if wire.last_data_at is not None else wire.response_at
                )
                if (
                    wire.phase in {"stream_idle", "json_body"}
                    and last_activity is not None
                    and now - last_activity >= IDLE_SECONDS
                ):
                    raise _timeout(wire.phase) from None
                if (
                    first_content_limit is not None
                    and not first
                    and now - started >= first_content_limit
                ):
                    raise _timeout("first_content") from None
                progress(stage=stage)
                continue
            if kind == "content" and content:
                text += value
                if len(text) > MAX_CONTENT:
                    raise ai.AIError("模型正文超过接收容量", code="response_too_large")
                visible = policy.append(prefix, _visible(text))
                if len(visible) > MAX_CONTENT:
                    raise ai.AIError("模型正文超过接收容量", code="response_too_large")
                last_safe_visible = visible
                if visible:
                    stage = "generating"
                    if not first:
                        first = True
                        progress(first_content=True)
                        diagnostics.transport_event("first_content")
                        trace = diagnostics.CURRENT.get()
                        if trace is not None:
                            trace.emit(
                                "model_first_content",
                                round=trace.model_rounds,
                                duration_ms=round((time.monotonic() - started) * 1000),
                            )
                    progress(stage=stage, partial_content=visible)
                elif (
                    first_content_limit is not None
                    and time.monotonic() - started >= first_content_limit
                ):
                    raise _timeout("first_content")
            elif kind == "error":
                raise value
            elif kind == "result":
                guard()
                return value
    except Exception as exc:
        failure = exc
        # Incremental writes are throttled. Persist the last safe visible chunk
        # on a timeout/length error without extending the model wait budget.
        # The request callback still fences cancelled/expired worker tokens.
        visible = last_safe_visible
        if isinstance(exc, ai.AIError):
            if not getattr(exc, "visible_content", ""):
                exc.visible_content = visible
            if exc.code == "model_timeout":
                timeout_kind = getattr(exc, "timeout_kind", "total")
                age = (
                    round((time.monotonic() - wire.last_data_at) * 1000)
                    if wire.last_data_at is not None
                    else None
                )
                exc.last_data_age_ms = age
                diagnostics.transport_event(
                    wire.phase, timeout_kind=timeout_kind, last_data_age_ms=age
                )
        if visible and len(visible) <= MAX_CONTENT:
            try:
                progress(final_partial=True, partial_content=visible)
            except Exception:
                pass  # Never replace the original failure or bypass a fence.
        raise
    finally:
        if isinstance(failure, ai.AIError):
            wire.abort_error = failure
        wire.abort()
        thread.join(timeout=1)
        if isinstance(failure, ai.AIError):
            failure.stream_quiesced = not thread.is_alive()


def _pinned_open(cfg, path, body, wire):
    wire.phase_started("connect")
    endpoint = solution_ai.model_url(cfg["base_url"])
    parts = urlsplit(endpoint)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    addresses = solution_ai.resolved_addresses(
        parts.hostname, port, allow_private=internal_approved(endpoint)
    )
    cls = (
        solution_ai.PinnedHTTPSConnection
        if parts.scheme == "https"
        else solution_ai.PinnedHTTPConnection
    )
    connection = cls(parts.hostname, port, addresses[0], timeout=wire.timeout(CONNECT_SECONDS))
    wire.install(connection=connection)
    connection.connect()
    wire.phase_started("request")
    connection.sock.settimeout(wire.timeout(CONNECT_SECONDS))
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if body.get("stream") else "application/json",
    }
    if cfg.get("api_key"):
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    connection.request("POST", parts.path.rstrip("/") + path, json.dumps(body).encode(), headers)
    wire.phase_started("response_headers")
    connection.sock.settimeout(wire.response_timeout())
    response = connection.getresponse()
    wire.install(response=response)
    diagnostics.transport_event(
        "response_headers", response_ms=round((time.monotonic() - wire.started) * 1000)
    )
    wire.body_phase = "stream_idle" if body.get("stream") else "json_body"
    return response


def _enterprise_open(provider, cfg, path, body, wire):
    endpoint = enterprise_url(provider, cfg["base_url"])
    # Keep the cancellable connection registration and bounded reads, while
    # using the same approved, DNS-pinned destination policy as every model call.
    return _pinned_open(
        {
            **cfg,
            "base_url": endpoint,
            "api_key": cfg.get("api_key", "") if provider != "ollama" else "",
        },
        path,
        body,
        wire,
    )


def _check_status(response):
    status = getattr(response, "status", 200)
    diagnostics.transport_status(status)
    if not 200 <= status < 300:
        error = ai.AIError(
            "模型服务拒绝请求", code=diagnostics.upstream_code(status), upstream_status=status
        )
        if status in (408, 504):
            error.timeout_kind = "upstream_timeout"
        raise error


def _read(wire, size):
    wire.phase = wire.body_phase
    sock = getattr(wire.connection, "sock", None) or _response_socket(wire.response)
    timeout = wire.timeout(IDLE_SECONDS)
    if sock is not None:
        sock.settimeout(timeout)
    chunk = wire.response.read1(size)
    wire.received(chunk)
    return chunk


def _close(wire):
    if wire.response is not None:
        wire.response.close()
    if wire.connection is not None:
        wire.connection.close()


def _network_error(exc, phase, interrupted=None):
    if interrupted is not None:
        return interrupted
    if isinstance(exc, urllib.error.HTTPError):
        return ai.AIError(
            "模型服务拒绝请求",
            code=diagnostics.upstream_code(exc.code),
            upstream_status=exc.code,
        )
    timed_out = isinstance(exc, TimeoutError) or isinstance(
        getattr(exc, "reason", None), TimeoutError
    )
    error = ai.AIError("模型连接或读取失败", code="model_timeout" if timed_out else "model_network")
    if timed_out:
        error.timeout_kind = phase
    return error


def _json_request(provider, cfg, path, body, wire, private):
    try:
        if private:
            _pinned_open(cfg, path, body, wire)
        else:
            _enterprise_open(provider, cfg, path, body, wire)
        _check_status(wire.response)
        pieces, length = [], 0
        while True:
            chunk = _read(wire, min(65536, MAX_BYTES + 1 - length))
            if not chunk:
                break
            length += len(chunk)
            if length > MAX_BYTES:
                raise ai.AIError("模型响应超过接收容量", code="response_too_large")
            pieces.append(chunk)
        result = json.loads(b"".join(pieces))
        if not isinstance(result, dict):
            raise ValueError()
        base = result.get("base_resp") or {}
        if (
            result.get("error")
            or not isinstance(base, dict)
            or base.get("status_code") not in (None, 0)
        ):
            raise ai.AIError("模型服务拒绝请求", code="model_rejected")
        return result
    except ai.AIError:
        raise
    except (OSError, urllib.error.URLError, http.client.HTTPException) as exc:
        raise _network_error(exc, wire.phase, wire.abort_error) from None
    except (ValueError, UnicodeError, TypeError):
        raise ai.AIError("模型响应格式无效", code="model_invalid_response") from None
    finally:
        _close(wire)


class _Events:
    def __init__(self, wire):
        self.wire = wire
        self.decoder = codecs.getincrementaldecoder("utf-8")()
        self.buffer = ""
        self.data = []
        self.done = False
        self.finish = None
        self.content = ""
        self.usage = {}
        self.reasoning_seen = False

    def feed(self, chunk):
        self.buffer += self.decoder.decode(chunk)
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            self.line(line.rstrip("\r"))

    def line(self, line):
        if not line:
            if self.data:
                self.event("\n".join(self.data))
                self.data = []
        elif line.startswith("data:"):
            self.data.append(line[5:].lstrip(" "))
        # SSE comments/event/id fields contain no answer text.

    def event(self, data):
        if self.done:
            raise ValueError()
        if data == "[DONE]":
            if self.finish is None:
                raise ValueError()
            self.done = True
            return
        row = json.loads(data)
        if not isinstance(row, dict):
            raise ValueError()
        if row.get("error"):
            raise ai.AIError("模型服务拒绝请求", code="model_rejected")
        usage = row.get("usage")
        if isinstance(usage, dict):
            self.usage = usage
        choices = row.get("choices")
        if not isinstance(choices, list) or len(choices) > 1:
            raise ValueError()
        if not choices:
            return  # Compatible usage-only final chunk.
        choice = choices[0]
        if not isinstance(choice, dict):
            raise ValueError()
        delta = choice.get("delta") or {}
        if not isinstance(delta, dict):
            raise ValueError()
        value = delta.get("content")
        if value is not None:
            if not isinstance(value, str) or self.finish is not None:
                raise ValueError()
            self.content += value
            if len(self.content) > MAX_CONTENT:
                raise ai.AIError("模型正文超过接收容量", code="response_too_large")
            if value:
                self.wire.publish("content", value)
        # Treat reasoning as activity only; never queue, persist or log its text.
        if (
            not self.reasoning_seen
            and isinstance(delta.get("reasoning_content"), str)
            and delta["reasoning_content"]
        ):
            self.reasoning_seen = True
            diagnostics.transport_event("first_reasoning")
        finish = choice.get("finish_reason")
        if finish is not None:
            if not isinstance(finish, str) or self.finish is not None:
                raise ValueError()
            self.finish = finish

    def result(self):
        if not self.done or self.finish is None:
            raise ValueError()
        if self.finish not in ("stop", "length"):
            raise ai.AIError("模型未完整生成回答", code="model_rejected")
        return {
            "choices": [{"message": {"content": self.content}, "finish_reason": self.finish}],
            "usage": self.usage,
        }


def _stream_request(provider, cfg, path, body, wire, kind):
    if not cfg.get("api_key"):
        raise ai.AIError("尚未配置模型密钥", code="model_auth")
    try:
        _pinned_open(cfg, path, body, wire)
        _check_status(wire.response)
        events, length = _Events(wire), 0
        while not events.done:
            chunk = _read(wire, min(65536, MAX_BYTES + 1 - length))
            if not chunk:
                break
            length += len(chunk)
            if length > MAX_BYTES:
                raise ai.AIError("模型响应超过接收容量", code="response_too_large")
            events.feed(chunk)
        return events.result()
    except ai.AIError:
        raise
    except (OSError, urllib.error.URLError, http.client.HTTPException) as exc:
        raise _network_error(exc, wire.phase, wire.abort_error) from None
    except (ValueError, UnicodeError, TypeError):
        raise ai.AIError("模型流响应不完整或格式无效", code="model_invalid_response") from None
    finally:
        _close(wire)


def call(provider, cfg, messages, request_fn=None, kind="general"):
    state = CURRENT.get()
    if state is None:
        return ai.chat(provider, cfg, messages, timeout=60, request_fn=request_fn)
    streaming = policy.applies(provider, cfg)
    private = request_fn is not None
    original_messages, draft, recovering = messages, "", False

    def work(wire):
        timeout = min(FIRST_RESPONSE_SECONDS, _remaining(state))
        if streaming:
            body = {
                "model": cfg["model"],
                "messages": messages,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            policy.tune(provider, cfg, body, kind=kind, recovering=recovering)
            result = diagnostics.model_call(
                lambda p, c, path, body, timeout: _stream_request(p, c, path, body, wire, kind),
                provider,
                cfg,
                "/chat/completions",
                body,
                timeout=timeout,
            )
            choice = result["choices"][0]
            suffix = _visible(choice["message"]["content"])
            answer = policy.append(draft, suffix)
            if len(answer) > MAX_CONTENT:
                raise ai.AIError("模型正文超过接收容量", code="response_too_large")
            if choice["finish_reason"] == "length":
                error = ai.AIError("模型输出达到本轮容量上限", code="output_limit")
                error.visible_content = answer
                raise error
            if not suffix:
                raise ai.AIError("模型没有返回回答正文", code="model_empty_response")
            return answer, result["usage"]

        def transport(p, c, path, body=None, timeout=120):
            del timeout
            return _json_request(p, c, path, body, wire, private)

        return ai.chat(provider, cfg, messages, timeout=timeout, request_fn=transport)

    while True:
        try:
            if recovering:
                checkpoint()
            return _monitor(
                work,
                content=streaming,
                prefix=draft,
                first_content_limit=FIRST_CONTENT_SECONDS
                if streaming and policy.kimi(provider, cfg)
                else None,
            )
        except ai.AIError as exc:
            if (
                streaming
                and not recovering
                and exc.code == "model_timeout"
                and claim_timeout_recovery(provider, cfg, exc)
            ):
                messages = policy.timeout_messages(original_messages)
                recovering = True
                continue
            if (
                not streaming
                or recovering
                or exc.code != "output_limit"
                or not claim_output_recovery(provider, cfg)
            ):
                raise
            draft = getattr(exc, "visible_content", "")
            messages = policy.recovery_messages(original_messages, draft)
            recovering = True


def request(provider, cfg, path, body=None, timeout=120, request_fn=None):
    """Monitored non-streaming tool/model round, without nesting diagnostic events."""
    state = CURRENT.get()
    original = request_fn if request_fn is not None else ai.request
    if state is None:
        return original(provider, cfg, path, body, timeout=timeout)
    return _monitor(
        lambda wire: _json_request(provider, cfg, path, body, wire, request_fn is not None)
    )
