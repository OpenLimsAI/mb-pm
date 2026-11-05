"""Exact own-policy contract; transport unit tests, not browser evidence."""

import copy
import time

import httpx
import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.core.security import pm_role
from app.services.oidc_status import ensure_active_token, ensure_enabled_user


@pytest.mark.parametrize(
    "case", ["valid", "missing", "other_subject", "other_org", "wrong_audience", "inactive"]
)
def test_pm_resource_policy_is_bound_to_current_delegated_token(monkeypatch, case):
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_MODE", "casdoor_v4_self_policy")
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "CASDOOR_ACCOUNT_STATUS_VISIBLE", True)
    monkeypatch.setattr(settings, "CASDOOR_CLIENT_SECRET", "synthetic-resource-only")
    monkeypatch.setattr(settings, "MDM_DELEGATION_CLIENT_ID", "synthetic-delegate")
    claims = {
        "iss": settings.casdoor_issuer,
        "aud": "synthetic-delegate",
        "sub": "synthetic-user",
        "iat": int(time.time()),
        "roles": ["old-snapshot"],
    }
    policy = {
        "id": claims["sub"],
        "owner": settings.CASDOOR_ORG,
        "isForbidden": False,
        "isDeleted": False,
        "needUpdatePassword": False,
        "lastChangePasswordTime": "",
        "roles": [{"owner": settings.CASDOOR_ORG, "name": "rd", "isEnabled": True}],
    }
    body = {
        "active": True,
        "client_id": claims["aud"],
        "sub": claims["sub"],
        "openlims_self_policy": policy,
    }
    if case == "missing":
        del body["openlims_self_policy"]
    if case == "other_subject":
        policy["id"] = "other"
    if case == "other_org":
        policy["owner"] = "other"
    if case == "wrong_audience":
        body["client_id"] = "other-audience"
    if case == "inactive":
        body["active"] = False

    class Provider:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, **kwargs):
            assert url.endswith("/introspect")
            assert isinstance(kwargs["auth"], httpx.BasicAuth)
            assert kwargs["data"] == {
                "token": "synthetic-delegated-token",
                "token_type_hint": "access_token",
            }
            return httpx.Response(200, json=body)

        def get(self, *args, **kwargs):
            raise AssertionError("No delegate-client profile read or management fallback")

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", Provider)
    if case == "valid":
        ensure_active_token("synthetic-delegated-token", claims, expected_audience=claims["aud"])
        assert claims["roles"] == policy["roles"]
    else:
        with pytest.raises(HTTPException):
            ensure_active_token(
                "synthetic-delegated-token", claims, expected_audience=claims["aud"]
            )
        assert claims["roles"] == ["old-snapshot"]


@pytest.mark.parametrize(
    "case",
    [
        "valid",
        "disabled_role",
        "empty_roles",
        "no_policy",
        "subject",
        "org",
        "issuer",
        "audience",
        "disabled",
        "deleted",
        "password_required",
        "changed_password",
        "missing_password_state",
        "missing_password_time",
        "role_string",
        "role_missing_enabled",
        "role_other_org",
        "role_extra_field",
        "offline",
        "invalid_token",
    ],
)
def test_fixed_self_policy(monkeypatch, case):
    monkeypatch.setitem(settings.__dict__, "CASDOOR_ACCOUNT_STATUS_MODE", "casdoor_v4_self_policy")
    now = int(time.time())
    claims = {
        "iss": settings.casdoor_issuer,
        "aud": "pm-synthetic",
        "sub": "synthetic-sub",
        "iat": now,
        "roles": ["admin-snapshot"],
    }
    user = {
        "id": claims["sub"],
        "owner": settings.CASDOOR_ORG,
        "isForbidden": False,
        "isDeleted": False,
        "needUpdatePassword": False,
        "lastChangePasswordTime": "",
        "roles": [{"owner": settings.CASDOOR_ORG, "name": "cmc_lead", "isEnabled": True}],
    }
    body = {
        "iss": claims["iss"],
        "aud": claims["aud"],
        "sub": claims["sub"],
        "openlims_self_policy": user,
    }
    if case == "no_policy":
        del body["openlims_self_policy"]
    elif case == "subject":
        user["id"] = "other"
    elif case == "org":
        user["owner"] = "other"
    elif case in {"issuer", "audience"}:
        body[{"issuer": "iss", "audience": "aud"}[case]] = "other"
    elif case in {"disabled", "deleted"}:
        user[{"disabled": "isForbidden", "deleted": "isDeleted"}[case]] = True
    elif case == "password_required":
        user["needUpdatePassword"] = True
    elif case == "changed_password":
        user["lastChangePasswordTime"] = "2030-01-01T00:00:00Z"
    elif case.startswith("missing_password_"):
        del user[
            {
                "missing_password_state": "needUpdatePassword",
                "missing_password_time": "lastChangePasswordTime",
            }[case]
        ]
    elif case == "disabled_role":
        user["roles"][0]["isEnabled"] = False
    elif case == "empty_roles":
        user["roles"] = []
    elif case == "role_string":
        user["roles"] = ["cmc_lead"]
    elif case == "role_missing_enabled":
        del user["roles"][0]["isEnabled"]
    elif case == "role_other_org":
        user["roles"][0]["owner"] = "other"
    elif case == "role_extra_field":
        user["roles"][0]["users"] = ["other-person"]
    seen = []

    class Provider:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def get(self, url, **kwargs):
            seen.append(url)
            assert url.endswith("/api/userinfo"), "No broad get-user/Basic fallback allowed"
            assert kwargs == {"headers": {"Authorization": "Bearer synthetic-input"}}
            if case == "offline":
                raise httpx.ConnectError("synthetic offline")
            return httpx.Response(401 if case == "invalid_token" else 200, json=copy.deepcopy(body))

    monkeypatch.setattr("app.services.oidc_status.httpx.Client", Provider)
    if case in {"valid", "disabled_role", "empty_roles", "password_required"}:
        ensure_enabled_user("synthetic-input", claims, authenticated_iat=now)
        assert claims["roles"] == user["roles"]
        assert claims["_iam_password_state"]["required"] == (case == "password_required")
        if case in {"disabled_role", "empty_roles"}:
            assert pm_role(claims) != "cmc_lead"
    else:
        with pytest.raises(HTTPException) as caught:
            ensure_enabled_user("synthetic-input", claims, authenticated_iat=now)
        assert caught.value.status_code in {401, 403, 503}
        assert claims["roles"] == ["admin-snapshot"]
    assert len(seen) == 1
