"""Shared portal cookie constants and IAM claim role helpers."""

from app.core.config import settings

PORTAL_LOGIN_COOKIE = "mbportal_iam_login"
PORTAL_SESSION_COOKIE = "mbportal_iam_session"


def enabled_roles(claims: dict) -> set[str]:
    entries = claims.get("roles")
    if not isinstance(entries, list):
        return set()
    return {
        role["name"]
        for role in entries
        if isinstance(role, dict)
        and role.get("owner") == settings.CASDOOR_ORG
        and role.get("isEnabled", True) is True
        and isinstance(role.get("name"), str)
    }
