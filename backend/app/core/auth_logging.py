"""Do not record one-time OAuth codes or state in web access logs."""

import json
import logging
import os
import re
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException


def auth_failure(request, reason: str, detail: str, status: int = 401) -> HTTPException:
    """Stable diagnostic codes; never log identity claims, cookies or provider payloads."""
    if request is not None:
        request.state.auth_reason = reason
    return HTTPException(status, detail, headers={"X-Auth-Reason": reason})


async def audit_auth_request(request, call_next):
    request_id = uuid.uuid4().hex
    request.state.request_id = request_id
    response = await call_next(request)
    if not request.url.path.startswith("/api/v1/"):
        return response
    response.headers["X-Request-ID"] = request_id
    reason = getattr(request.state, "auth_reason", None) or response.headers.get("X-Auth-Reason")
    refreshed = getattr(request.state, "auth_refreshed", False)
    if reason or refreshed:
        route = request.scope.get("route")
        # Route templates omit customer identifiers; no raw URL/query/header is recorded.
        path = getattr(route, "path", "/api/v1/unknown")
        if not isinstance(reason, str) or not re.fullmatch(r"[a-z_]{1,48}", reason):
            reason = "session_refreshed" if refreshed else "authentication_failed"
        instance = os.getenv("HOSTNAME", "app")
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", instance):
            instance = "app"
        logging.getLogger("auth.audit").info(
            "auth_event %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "time_utc": datetime.now(UTC).isoformat(),
                    "reason": reason,
                    "status": response.status_code,
                    "route": path,
                    "method": request.method,
                    "instance": instance,
                },
                sort_keys=True,
            ),
        )
    return response


class CallbackQueryFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            path = args[2].split("?", 1)[0]
            if path in {"/api/v1/auth/callback", "/api/v1/portal/callback"}:
                values = list(args)
                values[2] = path
                record.args = tuple(values)
        return True
