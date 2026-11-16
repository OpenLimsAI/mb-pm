"""Observe upload transport stages without buffering data or changing HTTP messages."""

import json
import logging
import re
import time
from uuid import uuid4

UPLOAD_PATH = "/api/v1/knowledge-sources/v3/upload"
LOGGER = logging.getLogger("cmc-pms.upload")


def _trace_id(query):
    # The browser may supply this non-secret ID when no response can reach it.
    # Do not decode or retain arbitrary query values, including duplicate IDs.
    if isinstance(query, bytes) and len(query) <= 4096:
        values = [part[13:] for part in query.split(b"&") if part.startswith(b"upload_trace=")]
        if len(values) == 1 and re.fullmatch(b"[a-f0-9]{32}", values[0]):
            return values[0].decode("ascii")
    return uuid4().hex


class UploadTraceMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != UPLOAD_PATH
        ):
            return await self.app(scope, receive, send)

        trace = _trace_id(scope.get("query_string", b""))
        started = time.monotonic()
        body_bytes = 0
        body_complete = False
        status = None
        emitted = set()

        def emit(event, exception=None):
            # At most one of each stage: no per-chunk logs or attacker messages.
            if event in emitted:
                return
            emitted.add(event)
            record = {
                "event": event,
                "trace": trace,
                "elapsed_ms": max(0, int((time.monotonic() - started) * 1000)),
                "body_bytes": body_bytes,
                "status": status,
            }
            if exception is not None:
                name = type(exception).__name__
                record["exception_type"] = (
                    name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,79}", name) else "Exception"
                )
            try:
                LOGGER.info("upload_event %s", json.dumps(record, separators=(",", ":")))
            except Exception:
                # An unavailable logging sink must not break an otherwise valid upload.
                pass

        async def observed_receive():
            nonlocal body_bytes, body_complete
            message = await receive()
            if message["type"] == "http.request" and not body_complete:
                body_bytes += len(message.get("body", b""))
                if not message.get("more_body", False):
                    body_complete = True
                    emit("body_complete")
            elif message["type"] == "http.disconnect":
                emit("disconnect")
            return message

        async def observed_send(message):
            nonlocal status
            await send(message)
            if message["type"] == "http.response.start":
                status = message["status"]
                emit("response_started")
            elif message["type"] == "http.response.body" and not message.get("more_body", False):
                emit("completed")

        emit("request_started")
        try:
            return await self.app(scope, observed_receive, observed_send)
        except BaseException as exception:
            emit("error", exception)
            raise
