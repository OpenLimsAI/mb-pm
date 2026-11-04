"""Bound bytes/time before parsing, but never consume an unauthenticated upload."""

import asyncio
import time

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


class RequestLimitsMiddleware:
    def __init__(self, app, max_bytes=32 * 1024 * 1024, max_uploads=32, seconds=60):
        self.app = app
        self.max_bytes = max_bytes
        self.max_uploads = max_uploads
        self.seconds = seconds
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "PATCH"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        limit = self.max_bytes
        if path == "/api/v1/feedback":
            limit = 16 * 1024 * 1024
        elif path == "/api/v1/templates/import":
            limit = 11 * 1024 * 1024
        elif path.startswith("/api/v1/integration/knowledge/ai/"):
            limit = 1024 * 1024
        lengths = [
            value for name, value in scope.get("headers", []) if name.lower() == b"content-length"
        ]
        if len(lengths) > 1 or (lengths and (not lengths[0].isdigit() or len(lengths[0]) > 20)):
            return await JSONResponse({"detail": "无效的请求长度"}, 400)(scope, receive, send)
        if lengths and int(lengths[0]) > limit:
            return await JSONResponse({"detail": "请求内容过大"}, 413)(scope, receive, send)
        if self.active >= self.max_uploads:
            return await JSONResponse(
                {"detail": "上传繁忙，请稍后重试"}, 429, headers={"Retry-After": "5"}
            )(scope, receive, send)
        self.active += 1
        acquired = True
        total = 0
        deadline = time.monotonic() + self.seconds

        def release():
            nonlocal acquired
            if acquired:
                self.active -= 1
                acquired = False

        async def bounded_receive():
            nonlocal total
            # Once the complete body is read, later receive calls are disconnect
            # watchers (e.g. streaming responses), not uploads. Do not time out AI
            # generation or long responses on the upload deadline.
            if not acquired:
                return await receive()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(408, "请求上传超时")
            try:
                message = await asyncio.wait_for(receive(), remaining)
            except TimeoutError as exc:
                raise HTTPException(408, "请求上传超时") from exc
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > limit:
                    raise HTTPException(413, "请求内容过大")
                if not message.get("more_body", False):
                    release()
            elif message["type"] == "http.disconnect":
                release()
            return message

        try:
            await self.app(scope, bounded_receive, send)
        finally:
            release()
