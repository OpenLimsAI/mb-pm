"""Configured MDM deep links. Never accept caller-supplied origins or identity."""

import re
from urllib.parse import quote, urlsplit

from fastapi import HTTPException

from app.core.config import settings


def mdm_base() -> str:
    value = settings.MDM_PUBLIC_URL
    try:
        parsed = urlsplit(value)
        valid = (
            bool(value)
            and value == value.strip()
            and not re.search(r"[\x00-\x20\x7f\\%]", value)
            and parsed.scheme in {"https", "http"}
            and bool(parsed.hostname)
            and not parsed.username
            and not parsed.password
            and not parsed.query
            and not parsed.fragment
            and (parsed.scheme == "https" or parsed.hostname in {"localhost", "127.0.0.1", "::1"})
            and all(segment not in {".", ".."} for segment in parsed.path.split("/"))
            and bool(parsed.port is None or 1 <= parsed.port <= 65535)
        )
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(503, "MDM 入口尚未配置或地址不安全")
    return value.rstrip("/")


def mdm_url(project_id: str | None = None) -> str:
    path = "/projects" if project_id is None else "/pm-projects/" + quote(project_id, safe="")
    return mdm_base() + path
