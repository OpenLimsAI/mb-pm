"""Bounded, cancellable generation for persisted personal-assistant requests.

The job worker owns the progress callback. Network I/O runs in a monitored thread;
callbacks (and therefore job leases/database writes) stay on the calling thread.
No transport retries, model fallback, credentials or reasoning text are exposed.
"""

import codecs
import http.client
import json
import math
import queue
import re
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

CONNECT_SECONDS = 15
IDLE_SECONDS = 120
MAX_BYTES = 2_000_000
MAX_CONTENT = 80_000
POLL_SECONDS = 0.5
CURRENT = ContextVar("assistant_generation", default=None)


@dataclass
class Generation:
    callback: object
    deadline: float


@contextmanager
def run_context(callback, budget_seconds=300):
    seconds = float(budget_seconds)
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("Generation budget must be a positive finite number")
    seconds = min(600, seconds)
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


def _remaining(state):
    remaining = state.deadline - time.monotonic()
    if remaining <= 0:
        raise ai.AIError("模型生成达到本轮等待上限", code="model_timeout")
    return remaining


def official_deepseek(cfg):
    """Vendor tuning/streaming never changes the selected endpoint or borrows a key."""
    try:
        parts = urlsplit(cfg.get("base_url", ""))
        return (
            parts.scheme == "https"
            and parts.hostname == "api.deepseek.com"
            and parts.port in (None, 443)
            and parts.username is None
            and parts.password is None
            and parts.path.rstrip("/") in ("", "/v1")
            and not parts.query
            and not parts.fragment
            and cfg.get("model") in ("deepseek-v4-pro", "deepseek-flash")
        )
    except (ValueError, TypeError):
        return False


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


def _response_socket(response):
    raw = getattr(getattr(response, "fp", None), "raw", None)
    return getattr(raw, "_sock", None)


def _visible(content):
    # Match ai.chat's existing handling; an unfinished think block is never shown.
    value = re.sub(r"<think>.*?(?:</think>|$)", "", content, flags=re.S)
    for size in range(1, len("<think>")):
        if value.endswith("<think>"[:size]):
            value = value[:-size]
            break
    return value.strip()


def _monitor(work, *, content=False):
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
    stage, text, first = "waiting_model", "", False
    started = time.monotonic()
    progress(stage=stage)
    thread.start()
    try:
        while True:
            guard()
            try:
                kind, value = wire.events.get(timeout=min(POLL_SECONDS, _remaining(state)))
            except queue.Empty:
                progress(stage=stage)
                continue
            if kind == "content" and content:
                text += value
                if len(text) > MAX_CONTENT:
                    raise ai.AIError("模型正文超过接收容量", code="response_too_large")
                visible = _visible(text)
                if visible:
                    stage = "generating"
                    if not first:
                        first = True
                        progress(first_content=True)
                        trace = diagnostics.CURRENT.get()
                        if trace is not None:
                            trace.emit(
                                "model_first_content",
                                round=trace.model_rounds,
                                duration_ms=round((time.monotonic() - started) * 1000),
                            )
                    progress(stage=stage, partial_content=visible)
            elif kind == "error":
                raise value
            elif kind == "result":
                guard()
                return value
    except Exception:
        # Incremental writes are throttled. Persist the last safe visible chunk
        # on a timeout/length error without extending the model wait budget.
        # The request callback still fences cancelled/expired worker tokens.
        visible = _visible(text)
        if visible and len(visible) <= MAX_CONTENT:
            try:
                progress(final_partial=True, partial_content=visible)
            except Exception:
                pass  # Never replace the original failure or bypass a fence.
        raise
    finally:
        wire.abort()
        thread.join(timeout=1)


def _pinned_open(cfg, path, body, wire):
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
    connection.sock.settimeout(wire.timeout(IDLE_SECONDS))
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if body.get("stream") else "application/json",
    }
    if cfg.get("api_key"):
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    connection.request("POST", parts.path.rstrip("/") + path, json.dumps(body).encode(), headers)
    connection.sock.settimeout(wire.timeout(IDLE_SECONDS))
    response = connection.getresponse()
    wire.install(response=response)
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
        raise ai.AIError(
            "模型服务拒绝请求", code=diagnostics.upstream_code(status), upstream_status=status
        )


def _read(wire, size):
    if wire.connection is not None:
        sock = getattr(wire.connection, "sock", None)
    else:
        sock = _response_socket(wire.response)
    timeout = wire.timeout(IDLE_SECONDS)
    if sock is not None:
        sock.settimeout(timeout)
    return wire.response.read1(size)


def _close(wire):
    if wire.response is not None:
        wire.response.close()
    if wire.connection is not None:
        wire.connection.close()


def _network_error(exc):
    if isinstance(exc, urllib.error.HTTPError):
        return ai.AIError(
            "模型服务拒绝请求",
            code=diagnostics.upstream_code(exc.code),
            upstream_status=exc.code,
        )
    timed_out = isinstance(exc, TimeoutError) or isinstance(
        getattr(exc, "reason", None), TimeoutError
    )
    return ai.AIError("模型连接或读取失败", code="model_timeout" if timed_out else "model_network")


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
        raise _network_error(exc) from None
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
        # reasoning_content is deliberately ignored, never queued or stored.
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
        raise _network_error(exc) from None
    except (ValueError, UnicodeError, TypeError):
        raise ai.AIError("模型流响应不完整或格式无效", code="model_invalid_response") from None
    finally:
        _close(wire)


def call(provider, cfg, messages, request_fn=None, kind="general"):
    state = CURRENT.get()
    if state is None:
        return ai.chat(provider, cfg, messages, timeout=60, request_fn=request_fn)
    streaming = official_deepseek(cfg) and provider in ("deepseek", "custom")
    private = request_fn is not None

    def work(wire):
        timeout = min(IDLE_SECONDS, _remaining(state))
        if streaming:
            body = {
                "model": cfg["model"],
                "messages": messages,
                "stream": True,
                "stream_options": {"include_usage": True},
                "reasoning_effort": "high" if kind == "analysis" else "low",
                "max_tokens": 16384 if kind == "analysis" else 8192,
            }
            result = diagnostics.model_call(
                lambda p, c, path, body, timeout: _stream_request(p, c, path, body, wire, kind),
                provider,
                cfg,
                "/chat/completions",
                body,
                timeout=timeout,
            )
            choice = result["choices"][0]
            if choice["finish_reason"] == "length":
                raise ai.AIError("模型输出达到本轮容量上限", code="output_limit")
            content = _visible(choice["message"]["content"])
            if not content:
                raise ai.AIError("模型没有返回回答正文", code="model_empty_response")
            return content, result["usage"]

        def transport(p, c, path, body=None, timeout=120):
            del timeout
            return _json_request(p, c, path, body, wire, private)

        return ai.chat(provider, cfg, messages, timeout=timeout, request_fn=transport)

    return _monitor(work, content=streaming)


def request(provider, cfg, path, body=None, timeout=120, request_fn=None):
    """Monitored non-streaming tool/model round, without nesting diagnostic events."""
    state = CURRENT.get()
    original = request_fn if request_fn is not None else ai.request
    if state is None:
        return original(provider, cfg, path, body, timeout=timeout)
    return _monitor(
        lambda wire: _json_request(provider, cfg, path, body, wire, request_fn is not None)
    )
