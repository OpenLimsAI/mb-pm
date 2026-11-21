"""The upload observer must remain a bounded, private, transparent ASGI wrapper."""

import asyncio
import json
import logging
import re
from pathlib import Path

import pytest

from app.middleware.upload_trace import UPLOAD_PATH, UploadTraceMiddleware


def request_scope(**changes):
    return {
        "type": "http",
        "method": "POST",
        "path": UPLOAD_PATH,
        "query_string": b"upload_trace=" + b"a" * 32 + b"&filename=private-document",
        "headers": [(b"cookie", b"session=private-cookie")],
        **changes,
    }


def records(caplog):
    return [
        json.loads(record.getMessage().removeprefix("upload_event "))
        for record in caplog.records
        if record.name == "cmc-pms.upload"
    ]


@pytest.fixture(autouse=True)
def capture_upload_logs(caplog):
    caplog.set_level(logging.INFO, logger="cmc-pms.upload")


def test_chunked_request_and_streamed_response_are_unchanged(caplog):
    incoming = [
        {"type": "http.request", "body": b"private-pdf-part-1", "more_body": True},
        {"type": "http.request", "body": b"private-pdf-part-2", "more_body": False},
    ]
    outgoing = [
        {
            "type": "http.response.start",
            "status": 201,
            "headers": [
                (b"content-length", b"11"),
                (b"x-request-id", b"existing-request-id"),
                (b"set-cookie", b"session=private-response-cookie"),
            ],
        },
        {"type": "http.response.body", "body": b"first", "more_body": True},
        {"type": "http.response.body", "body": b"second", "more_body": False},
    ]
    delivered = []
    consumed = []
    scope = request_scope()
    untouched_scope = dict(scope)

    async def receive():
        message = incoming[len(consumed)]
        consumed.append(message)
        return message

    async def send(message):
        delivered.append(message)

    async def target(observed_scope, read, write):
        assert observed_scope is scope
        assert not consumed, "The observer must not pre-read the request"
        assert await read() is incoming[0]
        assert await read() is incoming[1]
        for message in outgoing:
            await write(message)
        return "unchanged result"

    assert asyncio.run(UploadTraceMiddleware(target)(scope, receive, send)) == "unchanged result"
    assert scope == untouched_scope
    assert all(actual is expected for actual, expected in zip(delivered, outgoing, strict=True))
    values = records(caplog)
    assert [value["event"] for value in values] == [
        "request_started",
        "body_complete",
        "response_started",
        "completed",
    ]
    assert [value["body_bytes"] for value in values] == [0, 36, 36, 36]
    assert [value["status"] for value in values] == [None, None, 201, 201]
    assert all(value["trace"] == "a" * 32 for value in values)
    assert all(
        set(value) == {"event", "trace", "elapsed_ms", "body_bytes", "status"} for value in values
    )
    assert all(value["elapsed_ms"] >= 0 for value in values)
    assert [value["elapsed_ms"] for value in values] == sorted(
        value["elapsed_ms"] for value in values
    )
    assert "private-" not in caplog.text
    assert "existing-request-id" not in caplog.text
    assert UPLOAD_PATH not in caplog.text


def test_early_rejection_does_not_read_body_or_claim_body_completed(caplog):
    async def receive():
        pytest.fail("An early rejection must leave the request unread")

    async def send(message):
        pass

    async def target(scope, read, write):
        await write({"type": "http.response.start", "status": 401, "headers": []})
        await write({"type": "http.response.body", "body": b"unauthorized"})

    asyncio.run(UploadTraceMiddleware(target)(request_scope(), receive, send))
    values = records(caplog)
    assert [value["event"] for value in values] == [
        "request_started",
        "response_started",
        "completed",
    ]
    assert all(value["body_bytes"] == 0 for value in values)
    assert values[-1]["status"] == 401


def test_disconnect_is_forwarded_and_logged_only_once(caplog):
    received = {"type": "http.disconnect"}

    async def receive():
        return received

    async def target(scope, read, write):
        assert await read() is received
        assert await read() is received

    asyncio.run(UploadTraceMiddleware(target)(request_scope(), receive, None))
    assert [value["event"] for value in records(caplog)] == ["request_started", "disconnect"]


@pytest.mark.parametrize("error", [RuntimeError("private-error-message"), asyncio.CancelledError()])
def test_exception_and_cancellation_propagate_without_message_or_traceback(caplog, error):
    async def target(scope, read, write):
        raise error

    with pytest.raises(type(error)) as caught:
        asyncio.run(UploadTraceMiddleware(target)(request_scope(), None, None))
    assert caught.value is error
    values = records(caplog)
    assert [value["event"] for value in values] == ["request_started", "error"]
    assert values[-1]["exception_type"] == type(error).__name__
    assert set(values[-1]) == {
        "event",
        "trace",
        "elapsed_ms",
        "body_bytes",
        "status",
        "exception_type",
    }
    assert "private-error-message" not in caplog.text and "Traceback" not in caplog.text


def test_send_failure_never_claims_response_completed(caplog):
    error = OSError("private-network-details")

    async def send(message):
        if message["type"] == "http.response.body":
            raise error

    async def target(scope, read, write):
        await write({"type": "http.response.start", "status": 201, "headers": []})
        await write({"type": "http.response.body", "body": b"ok", "more_body": False})

    with pytest.raises(OSError) as caught:
        asyncio.run(UploadTraceMiddleware(target)(request_scope(), None, send))
    assert caught.value is error
    values = records(caplog)
    assert [value["event"] for value in values] == ["request_started", "response_started", "error"]
    assert values[-1]["status"] == 201
    assert "private-network-details" not in caplog.text


def test_receive_failure_retains_partial_byte_count_and_original_error(caplog):
    error = ConnectionResetError("private socket detail")
    reads = 0

    async def receive():
        nonlocal reads
        reads += 1
        if reads == 1:
            return {"type": "http.request", "body": b"partial", "more_body": True}
        raise error

    async def target(scope, read, write):
        await read()
        await read()

    with pytest.raises(ConnectionResetError) as caught:
        asyncio.run(UploadTraceMiddleware(target)(request_scope(), receive, None))
    assert caught.value is error
    values = records(caplog)
    assert [value["event"] for value in values] == ["request_started", "error"]
    assert values[-1]["body_bytes"] == 7
    assert values[-1]["exception_type"] == "ConnectionResetError"
    assert "private socket detail" not in caplog.text


@pytest.mark.parametrize(
    "changes",
    [
        {"method": "GET"},
        {"method": "OPTIONS"},
        {"path": "/api/v1/knowledge-sources/v3/upload/"},
        {"path": "/api/v1/knowledge-sources/v3/library/query"},
        {"type": "websocket"},
    ],
)
def test_other_routes_methods_and_protocols_are_not_observed(caplog, changes):
    expected_receive, expected_send = object(), object()
    scope = request_scope(**changes)

    async def target(actual_scope, receive, send):
        assert actual_scope is scope and receive is expected_receive and send is expected_send

    asyncio.run(UploadTraceMiddleware(target)(scope, expected_receive, expected_send))
    assert records(caplog) == []


@pytest.mark.parametrize(
    "query",
    [
        b"",
        b"upload_trace=private-query-secret",
        b"upload_trace=" + b"A" * 32,
        b"upload_trace=" + b"a" * 31,
        b"upload_trace=" + b"a" * 32 + b"&upload_trace=" + b"a" * 32,
        b"upload_trace=%61" + b"a" * 31,
        b"other=" + b"x" * 4096 + b"&upload_trace=" + b"a" * 32,
    ],
)
def test_untrusted_trace_is_rejected_without_logging_raw_query(caplog, query):
    async def target(scope, read, write):
        pass

    asyncio.run(UploadTraceMiddleware(target)(request_scope(query_string=query), None, None))
    value = records(caplog)[0]
    assert re.fullmatch(r"[a-f0-9]{32}", value["trace"])
    assert value["trace"] != "a" * 32
    assert "private-query-secret" not in caplog.text


def test_logs_are_bounded_even_for_repeated_messages(caplog):
    message = {"type": "http.request", "body": b"x", "more_body": False}

    async def receive():
        return message

    async def send(message):
        pass

    async def target(scope, read, write):
        for _ in range(100):
            await read()
            await write({"type": "http.response.start", "status": 201, "headers": []})
            await write({"type": "http.response.body", "body": b"ok"})

    asyncio.run(UploadTraceMiddleware(target)(request_scope(), receive, send))
    values = records(caplog)
    assert len(values) == 4
    assert values[-1]["body_bytes"] == 1


def test_logging_sink_failure_does_not_break_upload(monkeypatch):
    from app.middleware import upload_trace

    def broken_logger(*args, **kwargs):
        raise OSError("sink unavailable")

    monkeypatch.setattr(upload_trace.LOGGER, "info", broken_logger)

    async def target(scope, receive, send):
        return "ok"

    assert asyncio.run(UploadTraceMiddleware(target)(request_scope(), None, None)) == "ok"


def test_registration_observes_final_user_middleware_response():
    # No app import or database startup is needed to verify the registration order.
    source = (Path(__file__).parents[1] / "app/main.py").read_text()
    registration = source.index("app.add_middleware(UploadTraceMiddleware)")
    assert registration > source.index("async def prevent_auth_response_caching")
    assert registration > source.index("app.add_middleware(RequestLimitsMiddleware)")
