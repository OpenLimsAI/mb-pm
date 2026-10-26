"""Isolated contract TDD; fixture JWTs do not substitute real browser acceptance."""

import time
from copy import deepcopy
from uuid import uuid4
import pytest
from jose import jwt
from app.core.config import settings
from app.core.security import digest, seal
from app.db.session import SessionLocal
from app.models import IAMSession, PortalSession, Project

CREATE = "/api/v1/integration/mdm/projects"
BACK = "/api/v1/auth/backchannel-logout"
AUD = "mdm-delegation-test"
EVENT = "http://schemas.openid.net/event/backchannel-logout"


@pytest.fixture(autouse=True)
def cookies(client, monkeypatch):
    # Status transport has separate contract tests; these isolate marker/receipt behavior.
    monkeypatch.setattr("app.services.oidc_status.ensure_active_token", lambda *a, **kw: None)
    client.cookies.clear()
    yield
    client.cookies.clear()


@pytest.fixture
def creation(monkeypatch, iam_user, token_factory):
    monkeypatch.setitem(settings.__dict__, "MDM_DELEGATION_CLIENT_ID", AUD)
    monkeypatch.setitem(settings.__dict__, "MDM_SOURCE_NAMESPACE", "mdm")
    uid = iam_user("p2-create-lead", "cmc_lead")
    owner = iam_user("p2-chosen-owner", "rd")
    headers = {"Authorization": "Bearer " + token_factory("cmc_lead", sub=uid, name=uid, aud=[AUD])}
    payload = {
        "request_id": str(uuid4()),
        "source_id": "mdm",
        "source_project_id": str(int(uuid4().hex[:12], 16)),
        "project": {
            "code": "MDM-" + uuid4().hex[:12],
            "name": "Explicit project",
            "product_type": "单抗",
            "current_stage": "IND",
            "target_stage": "Ph3",
            "owner_id": owner,
            "planned_start": "2026-11-01",
            "planned_end": "2027-06-30",
        },
    }
    return uid, owner, headers, payload


def test_disabled_without_audience(client, creation, monkeypatch):
    _, _, h, p = creation
    monkeypatch.setitem(settings.__dict__, "MDM_DELEGATION_CLIENT_ID", "")
    response = client.post(CREATE, headers=h, json=p)
    assert response.status_code == 503


def test_only_delegate_and_actual_pm_creation_role(client, creation, token_factory):
    uid, _, _, p = creation
    response = client.post(CREATE, json=p)
    assert response.status_code == 401
    for aud in ["pms-test", "mdm-login-test"]:
        h = {"Authorization": "Bearer " + token_factory("cmc_lead", sub=uid, aud=[aud])}
        response = client.post(CREATE, headers=h, json=p)
        assert response.status_code == 401
    h = {"Authorization": "Bearer " + token_factory("rd", sub=uid, aud=[AUD])}
    response = client.post(CREATE, headers=h, json=p)
    assert response.status_code == 403


def test_creation_and_repeats_share_atomic_receipt(client, creation):
    uid, owner, h, p = creation
    r = client.post(CREATE, headers=h, json=p)
    assert r.status_code == 201, r.text
    receipt = r.json()
    assert receipt["request_id"] == p["request_id"] and receipt["created_by"] == uid
    assert receipt["project"]["id"] == receipt["project_id"] and receipt["project"]["bindable"]
    for _ in range(2):
        r = client.post(CREATE, headers=h, json=p)
        assert r.status_code == 200 and r.json() == receipt
    assert client.get(CREATE + "/" + p["request_id"], headers=h).json() == receipt
    with SessionLocal() as db:
        rows = db.query(Project).filter_by(code=p["project"]["code"]).all()
        assert len(rows) == 1 and rows[0].owner_id == owner
        assert rows[0].current_stage == "IND" and rows[0].target_stage == "Ph3"


def test_payload_and_registration_conflicts_do_not_duplicate(client, creation):
    _, _, h, p = creation
    response = client.post(CREATE, headers=h, json=p)
    assert response.status_code == 201
    changed = deepcopy(p)
    changed["project"]["name"] = "Changed"
    response = client.post(CREATE, headers=h, json=changed)
    assert response.status_code == 409
    response = client.post(CREATE, headers=h, json={**p, "request_id": str(uuid4())})
    assert response.status_code == 409
    with SessionLocal() as db:
        assert db.query(Project).filter_by(code=p["project"]["code"]).count() == 1


def test_owner_candidates_and_receipt_are_scoped(client, creation, iam_user, token_factory):
    uid, owner, h, p = creation
    response = client.get(CREATE + "/" + str(uuid4()), headers=h)
    assert response.status_code == 404
    r = client.get("/api/v1/integration/mdm/owners", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["current_user_id"] == uid and owner in {x["id"] for x in r.json()["items"]}
    assert all(set(x) == {"id", "display_name"} for x in r.json()["items"])
    response = client.post(CREATE, headers=h, json=p)
    assert response.status_code == 201
    other = iam_user("p2-other-lead", "cmc_lead")
    h2 = {"Authorization": "Bearer " + token_factory("cmc_lead", sub=other, aud=[AUD])}
    response = client.get(CREATE + "/" + p["request_id"], headers=h2)
    assert response.status_code == 404


@pytest.mark.parametrize(
    "bad",
    [
        {"owner_id": "missing"},
        {"current_stage": ""},
        {"product_type": "fake"},
        {"planned_end": "2026-01-01"},
        {"budget": 0},
        {"id": "browser-picked"},
    ],
)
def test_required_fields_are_not_guessed(bad, client, creation):
    _, _, h, p = creation
    p["project"].update(bad)
    response = client.post(CREATE, headers=h, json=p)
    assert response.status_code in {400, 422}
    with SessionLocal() as db:
        assert db.query(Project).filter_by(code=p["project"]["code"]).count() == 0


def test_delegate_audience_not_accepted_by_ordinary_pm(client, creation, project_factory):
    uid, _, h, _ = creation
    pid = project_factory(uid)
    response = client.get(f"/api/v1/projects/{pid}/integration-reference", headers=h)
    assert response.status_code == 200
    response = client.get(f"/api/v1/projects/{pid}", headers=h)
    assert response.status_code == 401


def logout_token(signing_pair, **changes):
    data = {
        "iss": settings.casdoor_issuer,
        "aud": [settings.CASDOOR_CLIENT_ID],
        "sub": "p2-logout-user",
        "iat": int(time.time()),
        "jti": str(uuid4()),
        "events": {EVENT: {}},
    }
    data.update(changes)
    return jwt.encode(data, signing_pair[0], algorithm="RS256", headers={"kid": "test-key"})


def test_backchannel_revokes_real_sessions_by_exact_audience(
    client, iam_user, token_factory, signing_pair, monkeypatch
):
    uid = iam_user("p2-logout-user", "cmc_lead")
    monkeypatch.setitem(settings.__dict__, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "PORTAL_PUBLIC_URL", "http://portal.test")
    monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "portal-test")
    monkeypatch.setattr(settings, "PORTAL_CLIENT_SECRET", "synthetic-secret")
    pm = token_factory("cmc_lead", sub=uid, name=uid, iat=int(time.time()) - 5, sid="p2sid")
    portal = token_factory(
        "cmc_lead", sub=uid, name=uid, aud=["portal-test"], iat=int(time.time()) - 5, sid="p2sid"
    )
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=digest("p2pm"),
                tokens=seal({"access_token": pm}),
                expires_at=int(time.time()) + 100,
            )
        )
        db.add(
            PortalSession(
                id=digest("p2portal"),
                tokens=seal({"access_token": portal}),
                expires_at=int(time.time()) + 100,
            )
        )
        db.commit()
    client.cookies.set("mbpm_iam_session", "p2pm")
    client.cookies.set("mbportal_iam_session", "p2portal")
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 200
    response = client.get("/api/v1/portal/me")
    assert response.status_code == 200
    signed = logout_token(signing_pair, sub=uid)
    for _ in range(2):
        response = client.post(BACK, data={"logout_token": signed})
        assert response.status_code == 200
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 401
    response = client.get("/api/v1/portal/me")
    assert response.status_code == 200
    signed = logout_token(signing_pair, sub=uid, aud=["portal-test"])
    response = client.post(BACK, data={"logout_token": signed})
    assert response.status_code == 200
    response = client.get("/api/v1/portal/me")
    assert response.status_code == 401


@pytest.mark.parametrize(
    "change",
    [
        {"aud": ["mdm-login-test"]},
        {"iss": "https://evil.test"},
        {"iat": 1},
        {"events": {}},
        {"nonce": "forbidden"},
        {"sub": "", "sid": ""},
    ],
)
def test_backchannel_rejects_invalid_events(
    change, client, token_factory, signing_pair, monkeypatch
):
    monkeypatch.setitem(settings.__dict__, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    response = client.post(BACK, data={"logout_token": logout_token(signing_pair, **change)})
    assert response.status_code in {400, 401}


def test_signed_sub_logout_ignores_mismatched_provider_sid_conservatively(
    client, iam_user, token_factory, signing_pair, monkeypatch
):
    uid = iam_user("p2-wide-logout", "cmc_lead")
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    access = token_factory(
        "cmc_lead", sub=uid, name=uid, sid="actual-browser-sid", iat=int(time.time()) - 5
    )
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=digest("p2-wide-cookie"),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 100,
            )
        )
        db.commit()
    client.cookies.set("mbpm_iam_session", "p2-wide-cookie")
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 200
    event = logout_token(signing_pair, sub=uid, sid="provider-other-beego-sid")
    response = client.post(BACK, data={"logout_token": event})
    assert response.status_code == 200
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 401


def test_local_logout_preserves_other_application_session(
    client, iam_user, token_factory, monkeypatch
):
    uid = iam_user("p2-local-logout", "cmc_lead")
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    access = token_factory("cmc_lead", sub=uid, name=uid, iat=int(time.time()) - 5)
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=digest("p2-local-pm"),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 100,
            )
        )
        db.add(
            PortalSession(
                id=digest("p2-local-portal"),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 100,
            )
        )
        db.commit()
    client.cookies.set("mbpm_iam_session", "p2-local-pm")
    client.cookies.set("mbportal_iam_session", "p2-local-portal")
    response = client.post(
        "/api/v1/auth/logout/local", headers={"Origin": settings.pms_origin}, follow_redirects=False
    )
    assert response.status_code == 303
    assert response.headers["location"] == settings.pms_origin + "/login?local=1&app=pm"
    response = client.get("/api/v1/auth/me")
    assert response.status_code == 401
    response = client.get("/api/v1/portal/me")
    assert response.status_code == 200


def test_created_source_receipt_prevents_orphaning_by_project_delete(
    client, creation, token_factory
):
    uid, _, h, p = creation
    response = client.post(CREATE, headers=h, json=p)
    assert response.status_code == 201
    project_id = response.json()["project_id"]
    ordinary = {"Authorization": "Bearer " + token_factory("cmc_lead", sub=uid, name=uid)}
    response = client.delete("/api/v1/projects/" + project_id, headers=ordinary)
    assert response.status_code == 409
    response = client.get(CREATE + "/" + p["request_id"], headers=h)
    assert response.status_code == 200


def test_concurrent_replays_create_only_one_execution_project(client, creation):
    from concurrent.futures import ThreadPoolExecutor

    _, _, h, p = creation
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post(CREATE, headers=h, json=p), range(4)))
    assert sorted(r.status_code for r in responses) == [200, 200, 200, 201]
    assert len({r.json()["project_id"] for r in responses}) == 1
    with SessionLocal() as db:
        assert db.query(Project).filter_by(code=p["project"]["code"]).count() == 1


@pytest.mark.parametrize("provider_ok", [True, False, "malformed"])
def test_global_logout_uses_server_token_and_reports_partial_failure(
    provider_ok, client, iam_user, token_factory, monkeypatch
):
    import httpx

    uid = iam_user("p2-global-out", "cmc_lead")
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    access = token_factory("cmc_lead", sub=uid, name=uid, iat=int(time.time()) - 5)
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=digest("p2-global-pm"),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 100,
            )
        )
        db.commit()
    seen = []
    status_checks = []

    class Provider:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, params=None, headers=None, **kwargs):
            if url.endswith("/api/login/oauth/introspect"):
                status_checks.append(True)
                return httpx.Response(
                    200,
                    json={
                        "active": len(status_checks) == 1,
                        "client_id": settings.CASDOOR_CLIENT_ID,
                        "sub": uid,
                    },
                )
            seen.append(
                {
                    "url": url,
                    "global": params == {"logoutAll": "true"},
                    "has_bearer": headers.get("Authorization", "").startswith("Bearer "),
                }
            )
            return httpx.Response(
                200 if provider_ok else 503,
                json=[]
                if provider_ok == "malformed"
                else {"status": "ok" if provider_ok else "error"},
            )

    monkeypatch.setattr("app.services.oidc_logout.httpx.Client", Provider)
    client.cookies.set("mbpm_iam_session", "p2-global-pm")
    response = client.post(
        "/api/v1/auth/logout", headers={"Origin": settings.pms_origin}, follow_redirects=False
    )
    assert response.status_code == 303
    assert seen == [
        {
            "url": settings.casdoor_internal_url + "/api/sso-logout",
            "global": True,
            "has_bearer": True,
        }
    ]
    location = response.headers["location"]
    assert "id_token_hint" not in location and "access_token" not in location
    if provider_ok is True:
        assert location.startswith(settings.casdoor_issuer + "/api/logout?")
    else:
        assert location == settings.pms_origin + "/login?error=logout_incomplete"
    response = client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + access})
    assert response.status_code == 401


def test_audit_failure_rolls_back_project_and_creation_receipt(client, creation):
    from sqlalchemy import event
    from sqlalchemy.exc import IntegrityError
    from app.models import AuditLog
    from app.models.mdm_integration import MDMProjectReceipt

    _, _, h, p = creation

    def fail_audit(*args):
        raise IntegrityError("synthetic audit failure", {}, Exception("synthetic"))

    event.listen(AuditLog, "before_insert", fail_audit)
    try:
        response = client.post(CREATE, headers=h, json=p)
    finally:
        event.remove(AuditLog, "before_insert", fail_audit)
    assert response.status_code == 409
    with SessionLocal() as db:
        assert db.query(Project).filter_by(code=p["project"]["code"]).count() == 0
        assert db.get(MDMProjectReceipt, p["request_id"]) is None


def test_callback_access_logs_do_not_include_authorization_code():
    import logging
    from app.core.auth_logging import CallbackQueryFilter

    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "unit",
        1,
        "%s %s %s %s %s",
        ("client", "GET", "/api/v1/auth/callback?code=one-use-example&state=example", "1.1", 303),
        None,
    )
    assert CallbackQueryFilter().filter(record) is True
    assert record.args[2] == "/api/v1/auth/callback"


def test_portal_backchannel_uses_its_configured_jwks(client, signing_pair, monkeypatch):
    from app.services import oidc_logout

    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    monkeypatch.setattr(settings, "PORTAL_CLIENT_ID", "portal-distinct-key")
    monkeypatch.setattr(settings, "PORTAL_JWKS_URL", "http://configured.test/portal-jwks")
    seen = []

    def portal_key(kid, *, jwks_url=None):
        seen.append(jwks_url)
        return signing_pair[1]

    monkeypatch.setattr(oidc_logout, "signing_key", portal_key)
    response = client.post(
        BACK, data={"logout_token": logout_token(signing_pair, aud=["portal-distinct-key"])}
    )
    assert response.status_code == 200
    assert seen == ["http://configured.test/portal-jwks"]


def test_pm_subject_logout_also_revokes_old_pm_delegate(
    client, creation, signing_pair, monkeypatch
):
    uid, _, h, _ = creation
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    response = client.get("/api/v1/integration/mdm/owners", headers=h)
    assert response.status_code == 200
    event = logout_token(signing_pair, sub=uid)
    response = client.post(BACK, data={"logout_token": event})
    assert response.status_code == 200
    response = client.get("/api/v1/integration/mdm/owners", headers=h)
    assert response.status_code == 401


@pytest.mark.parametrize("portal", [False, True])
def test_disabled_global_mode_logout_never_places_tokens_in_url(
    portal, client, iam_user, token_factory, monkeypatch
):
    from urllib.parse import urlsplit, parse_qs

    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", False)
    uid = iam_user("p2-old-logout", "cmc_lead")
    access = token_factory("cmc_lead", sub=uid, name=uid)
    model = PortalSession if portal else IAMSession
    cookie = "mbportal_iam_session" if portal else "mbpm_iam_session"
    with SessionLocal() as db:
        db.add(
            model(
                id=digest("p2-legacy"),
                tokens=seal({"access_token": access, "id_token": "synthetic-id-hint"}),
                expires_at=int(time.time()) + 60,
            )
        )
        db.commit()
    client.cookies.set(cookie, "p2-legacy")
    prefix = "portal" if portal else "auth"
    origin = settings.portal_origin if portal else settings.pms_origin
    response = client.post(
        "/api/v1/" + prefix + "/logout", headers={"Origin": origin}, follow_redirects=False
    )
    assert response.status_code == 303
    params = parse_qs(urlsplit(response.headers["location"]).query)
    assert set(params) == {"client_id", "post_logout_redirect_uri"}
    assert params["post_logout_redirect_uri"] == [origin + "/login"]


def test_invalid_notification_and_other_subject_do_not_revoke_caller(
    client, iam_user, token_factory, signing_pair, monkeypatch
):
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    uid = iam_user("p2-unaffected", "cmc_lead")
    headers = {
        "Authorization": "Bearer "
        + token_factory("cmc_lead", sub=uid, name=uid, iat=int(time.time()) - 5)
    }
    response = client.get("/api/v1/auth/me", headers=headers)
    assert response.status_code == 200
    response = client.post(
        BACK,
        data={
            "logout_token": logout_token(signing_pair, sub=uid, iss="https://invalid-issuer.test")
        },
    )
    assert response.status_code == 401
    response = client.get("/api/v1/auth/me", headers=headers)
    assert response.status_code == 200
    response = client.post(
        BACK, data={"logout_token": logout_token(signing_pair, sub="p2-another-subject")}
    )
    assert response.status_code == 200
    response = client.get("/api/v1/auth/me", headers=headers)
    assert response.status_code == 200


@pytest.mark.parametrize("case", ["still_active", "status_outage", "wrong_subject", "inactive"])
def test_global_logout_requires_active_preflight_and_inactive_postcondition(
    case, client, iam_user, token_factory, monkeypatch
):
    import httpx

    uid = iam_user("p2-global-verify", "cmc_lead")
    monkeypatch.setattr(settings, "OIDC_GLOBAL_LOGOUT_ENABLED", True)
    access = token_factory("cmc_lead", sub=uid, name=uid, iat=int(time.time()) - 5)
    with SessionLocal() as db:
        db.add(
            IAMSession(
                id=digest("p2-verify-cookie"),
                tokens=seal({"access_token": access}),
                expires_at=int(time.time()) + 100,
            )
        )
        db.commit()
    checks = []

    class Provider:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, **kwargs):
            if url.endswith("/api/login/oauth/introspect"):
                checks.append(True)
                if len(checks) == 2:
                    if case == "status_outage":
                        raise httpx.ReadTimeout("synthetic timeout")
                    if case == "inactive":
                        return httpx.Response(200, json={"active": False})
                return httpx.Response(
                    200,
                    json={
                        "active": True,
                        "client_id": settings.CASDOOR_CLIENT_ID,
                        "sub": "another-subject" if case == "wrong_subject" else uid,
                    },
                )
            assert url.endswith("/api/sso-logout")
            return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr("app.services.oidc_logout.httpx.Client", Provider)
    client.cookies.set("mbpm_iam_session", "p2-verify-cookie")
    response = client.post(
        "/api/v1/auth/logout", headers={"Origin": settings.pms_origin}, follow_redirects=False
    )
    assert response.status_code == 303
    location = response.headers["location"]
    if case == "inactive":
        assert location.startswith(settings.casdoor_issuer + "/api/logout?")
    else:
        assert location == settings.pms_origin + "/login?error=logout_incomplete"
    assert len(checks) == (1 if case == "wrong_subject" else 2)
