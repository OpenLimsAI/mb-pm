"""Explicit model destination approvals; a user-supplied URL is not an approval."""

import ipaddress
import os
from urllib.parse import urlsplit

OFFICIAL_HOSTS = {
    "deepseek": {"api.deepseek.com"},
    "minimax": {"api.minimaxi.com", "api.minimax.io"},
    "kimi": {"api.moonshot.cn", "api.moonshot.ai"},
}


def origin(value):
    parts = urlsplit(value)
    host = (parts.hostname or "").lower().rstrip(".")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return parts.scheme, host, port


def internal_approved(value):
    target = origin(value)
    for entry in os.environ.get("AI_ALLOWED_INTERNAL_ORIGINS", "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            parts = urlsplit(entry)
            if (
                parts.scheme in {"http", "https"}
                and parts.hostname
                and not parts.username
                and not parts.password
                and parts.path in {"", "/"}
                and not parts.query
                and not parts.fragment
                and origin(entry) == target
            ):
                return True
        except ValueError:
            continue
    return False


def validate_origin(value):
    parts = urlsplit(value)
    if internal_approved(value):
        return
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme != "https":
        raise ValueError("模型仅允许公网 HTTPS，内部模型须由管理员批准源站")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if not address.is_global:
            raise ValueError("内部模型源站尚未获管理员批准")
        return
    if (
        host == "localhost"
        or host.endswith((".localhost", ".local", ".internal"))
        or "." not in host
    ):
        raise ValueError("内部模型源站尚未获管理员批准")
    # Actual DNS answers are checked and pinned at connection time.


def enterprise_url(provider, value):
    from app.schemas.solution_ai import model_url

    value = model_url(value)
    if internal_approved(value):
        return value
    scheme, host, port = origin(value)
    if (
        provider not in OFFICIAL_HOSTS
        or scheme != "https"
        or port != 443
        or host not in OFFICIAL_HOSTS[provider]
    ):
        raise ValueError("企业云模型须使用官方 HTTPS 地址；内部模型须由管理员批准源站")
    return value
