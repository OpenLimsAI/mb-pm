"""Pure transport contract; not browser/E2E. Preserves e074 password/role checks."""
import time

import httpx
import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.core.security import pm_role
from app.services.oidc_status import ensure_enabled_user


@pytest.mark.parametrize("case", [
    "valid", "changed_roles", "subject", "issuer", "audience", "missing_roles",
    "missing_password_state", "missing_password_time", "old_login", "bad_time",
    "denied", "offline", "malformed", "empty_roles", "policy_denied",
    "policy_mismatch", "resource_unconfigured",
])
def test_live_userinfo_preserves_e074_policy(monkeypatch, case):
    monkeypatch.setitem(settings.__dict__, "CASDOOR_ACCOUNT_STATUS_MODE", "casdoor_v4_userinfo")
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "synthetic-resource-secret")
    claims = {"sub": "synthetic-sub", "iss": settings.casdoor_issuer,
              "aud": "synthetic-client", "iat": int(time.time()), "roles": ["admin-snapshot"]}
    identity = {"sub": claims["sub"], "iss": claims["iss"], "aud": claims["aud"], "roles": ["rd"]}
    body = {"id": claims["sub"], "owner": settings.CASDOOR_ORG, "isForbidden": False,
            "isDeleted": False, "roles": [{"owner": settings.CASDOOR_ORG, "name": "rd", "isEnabled": True}],
            "needUpdatePassword": False, "lastChangePasswordTime": ""}
    if case == "changed_roles":
        body["roles"] = [{"owner": settings.CASDOOR_ORG, "name": "cmc_lead", "isEnabled": False}]
    elif case in {"subject", "issuer", "audience"}:
        identity[{"subject": "sub", "issuer": "iss", "audience": "aud"}[case]] = "other"
    elif case.startswith("missing_"):
        del body[{"missing_roles": "roles", "missing_password_state": "needUpdatePassword",
                  "missing_password_time": "lastChangePasswordTime"}[case]]
    elif case == "old_login":
        body["lastChangePasswordTime"] = "2030-01-01T00:00:00Z"
    elif case == "bad_time":
        body["lastChangePasswordTime"] = "invalid"
    elif case == "empty_roles":
        body["roles"] = []
    elif case == "policy_mismatch":
        body["id"] = "other-policy-subject"
    elif case == "resource_unconfigured":
        monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "")

    seen = []

    class Provider:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
            assert kwargs["follow_redirects"] is False
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def get(self, url, **kwargs):
            seen.append(url)
            if url.endswith("/api/userinfo"):
                assert kwargs == {"headers": {"Authorization": "Bearer synthetic-input"}}
                if case == "offline":
                    raise httpx.ConnectError("synthetic offline")
                if case == "denied":
                    return httpx.Response(401)
                return httpx.Response(200, json=[] if case == "malformed" else identity)
            assert url.endswith("/api/get-user")
            assert kwargs["params"] == {"owner": settings.CASDOOR_ORG, "userId": "synthetic-sub"}
            assert isinstance(kwargs["auth"], httpx.BasicAuth)
            assert "headers" not in kwargs
            return httpx.Response(200, json={"status": "error"} if case == "policy_denied" else {"status": "ok", "data": body})

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", Provider)
    if case in {"valid", "changed_roles", "empty_roles"}:
        ensure_enabled_user("synthetic-input", claims, authenticated_iat=claims["iat"])
        assert claims["roles"] == body["roles"]
        assert claims["_iam_password_state"] == {"required": False, "changed_at": 0}
        if case == "changed_roles":
            assert pm_role(claims) != "cmc_lead", "Disabled role must not be granted"
    else:
        expected = 401 if case in {"subject", "issuer", "audience", "denied", "old_login", "policy_mismatch"} else 503
        with pytest.raises(HTTPException) as error:
            ensure_enabled_user("synthetic-input", claims, authenticated_iat=claims["iat"])
        assert error.value.status_code == expected
        assert claims["roles"] == ["admin-snapshot"]
        assert "_iam_password_state" not in claims
    assert len(seen) == (1 if case in {"subject", "issuer", "audience", "denied", "offline", "malformed", "resource_unconfigured"} else 2)
