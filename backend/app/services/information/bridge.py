"""Narrow server-to-server KB connector. No browser cookies or Core token are copied."""

import hashlib
import hmac
import json
import time
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from app.core.config import settings


class BridgeError(ValueError):
    """Preserve actionable permission/conflict statuses without exposing credentials."""

    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def call(operation, subject, **values):
    if not settings.INFORMATION_KB_URL or len(settings.INFORMATION_KB_SECRET) < 32:
        raise ValueError("知识库连接尚未配置，请联系管理员；原文归档不受影响")
    target = settings.INFORMATION_KB_URL.rstrip("/") + "/internal/information"
    parsed = urlsplit(target)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise ValueError("知识库连接地址配置无效")
    body = json.dumps(
        {"operation": operation, "subject": subject, **values},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    timestamp = str(int(time.time()))
    nonce = str(uuid4())
    content_digest = hashlib.sha256(body).hexdigest()
    signature = hmac.new(
        settings.INFORMATION_KB_SECRET.encode(),
        timestamp.encode() + b"\n" + nonce.encode() + b"\n" + content_digest.encode(),
        hashlib.sha256,
    ).hexdigest()
    try:
        response = httpx.post(
            target,
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Information-Time": timestamp,
                "X-Information-Nonce": nonce,
                "X-Information-Signature": signature,
                "X-Information-Content-SHA256": content_digest,
            },
            timeout=httpx.Timeout(
                120
                if operation == "exportPapers"
                else 90
                if operation in ("import", "uploadPaper")
                else 35
                if operation
                in ("readOriginal", "readPaper", "indexUploadedPaper", "statusUploadedPaper")
                else 12,
                connect=5,
            ),
            follow_redirects=False,
            trust_env=False,
        )
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("知识库返回了无效结果")
        if response.status_code != 200:
            message = data.get("error", {}).get("message", "知识库暂时无法处理此请求")
            raise BridgeError(response.status_code, str(message)[:500])
        return data
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        raise ValueError("无法连接知识库服务，请检查服务状态后重试") from exc
