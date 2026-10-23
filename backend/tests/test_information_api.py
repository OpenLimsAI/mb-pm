"""Real HTTP authorization, persistence and protected original downloads."""

import pytest
from test_information_portal import information_portal  # noqa: F401
from app.core.config import settings
from app.services import iam_admin, password_policy
from app.services.information.store import Store, tenant_key
from test_information_live import catalogue
from app.services.information.ich import parse_catalogue


@pytest.fixture
def live(information_portal, monkeypatch, tmp_path):
    client, db, session = information_portal
    monkeypatch.setattr(settings, "INFORMATION_DATA_DIR", str(tmp_path))
    role = {"value": "kb_manager"}

    def account(subject):
        return {
            "id": subject,
            "owner": settings.CASDOOR_ORG,
            "name": "fixture.user",
            "displayName": "Fixture User",
            "roles": [{"owner": settings.CASDOOR_ORG, "name": role["value"]}],
        }

    monkeypatch.setattr(iam_admin, "get_user_by_sub", account)
    monkeypatch.setattr(settings, "INFORMATION_WORKER_ENABLED", True)
    monkeypatch.setattr(settings, "INFORMATION_KB_URL", "")
    monkeypatch.setattr(settings, "INFORMATION_KB_SECRET", "")
    yield client, db, session, role


def test_snapshot_requires_auth_and_contains_no_seed_papers(live):
    client, db, session, role = live
    assert client.get("/api/v1/information/snapshot").status_code == 401
    response = client.get("/api/v1/information/snapshot", headers=session())
    assert response.status_code == 200
    payload = response.json()
    assert payload["canManage"] is True and payload["documents"] == []
    assert payload["events"] == [] and payload["jobs"] == []
    assert payload["sources"][0]["status"] == "unchecked"
    assert response.headers["cache-control"] == "no-store"
    from app.models import User, IAMIdentity

    assert db.query(User).count() == 0 and db.query(IAMIdentity).count() == 0


def test_live_roles_override_stale_admin_claims_and_csrf_is_required(live):
    client, db, session, role = live
    headers = session(roles=[{"owner": settings.CASDOOR_ORG, "name": "admin"}])
    source = client.get("/api/v1/information/snapshot", headers=headers).json()["sources"][0]
    role["value"] = "kb_editor"
    assert client.get("/api/v1/information/snapshot", headers=headers).json()["canManage"] is False
    path = f'/api/v1/information/sources/{source["id"]}/check'
    assert (
        client.post(path, headers={**headers, "Origin": settings.portal_origin}).status_code == 403
    )
    role["value"] = "admin"
    assert client.post(path, headers=headers).status_code == 403
    assert (
        client.post(path, headers={**headers, "Origin": settings.portal_origin}).status_code == 202
    )


def test_change_password_guard_applies_to_real_information_apis(live):
    client, db, session, role = live
    headers = session()
    password_policy.require_change(db, "information-only", "temporary")
    db.commit()
    assert client.get("/api/v1/information/snapshot", headers=headers).status_code == 403


def test_personal_preferences_survive_requests_without_leaking_to_other_subject(live):
    client, db, session, role = live
    alice, bob = session(sub="alice"), session(sub="bob")
    headers = {**alice, "Origin": settings.portal_origin}
    assert (
        client.post(
            "/api/v1/information/preferences",
            headers=headers,
            json={"note": "private note", "digest": "暂停提醒"},
        ).status_code
        == 200
    )
    assert (
        client.get("/api/v1/information/snapshot", headers=alice).json()["note"] == "private note"
    )
    assert client.get("/api/v1/information/snapshot", headers=bob).json()["note"] == ""


def test_original_download_is_auth_and_document_version_bound(live):
    client, db, session, role = live
    store = Store(db, tenant_key(settings.casdoor_issuer, settings.CASDOOR_ORG))
    source = store.ensure_source()
    store.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    db.commit()
    doc = store.documents()[0]
    version = store.archive(
        doc["id"], b"%PDF-original-http", "real parsed text", parse_status="ready"
    )
    db.commit()
    path = version["archiveUrl"]
    assert client.get(path).status_code == 401
    result = client.get(path, headers=session())
    assert result.status_code == 200 and result.content == b"%PDF-original-http"
    assert result.headers["x-content-type-options"] == "nosniff"
    assert result.headers["cache-control"] == "no-store"
    assert client.get(path.replace(doc["id"], "a" * 64), headers=session()).status_code == 404


def test_source_job_is_durable_and_paused_control_survives_new_request(live):
    client, db, session, role = live
    headers = {**session(), "Origin": settings.portal_origin}
    snapshot = client.get("/api/v1/information/snapshot", headers=headers).json()
    source = snapshot["sources"][0]
    result = client.post(f'/api/v1/information/sources/{source["id"]}/check', headers=headers)
    assert result.status_code == 202
    ident = result.json()["id"]
    assert (
        client.post(
            f"/api/v1/information/jobs/{ident}/control", headers=headers, json={"action": "pause"}
        ).status_code
        == 200
    )
    again = client.get("/api/v1/information/snapshot", headers=headers).json()
    assert again["runs"][0]["status"] == "paused"
    assert (
        client.post(
            f"/api/v1/information/jobs/{ident}/control", headers=headers, json={"action": "resume"}
        ).status_code
        == 200
    )


def test_text_is_searchable_without_bloating_snapshot(live):
    from app.models.information import InformationEntry

    client, db, session, role = live
    store = Store(db, tenant_key(settings.casdoor_issuer, settings.CASDOOR_ORG))
    source = store.ensure_source()
    store.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    doc = store.documents()[0]
    version = store.archive(
        doc["id"], b"%PDF-search-fixture", "specific searchable phrase 100%", parse_status="ready"
    )
    db.commit()
    assert "text" not in db.get(InformationEntry, version["id"]).data
    snapshot = client.get("/api/v1/information/snapshot", headers=session()).json()
    assert "specific searchable phrase" not in str(snapshot)
    result = client.get(
        "/api/v1/information/search", params={"q": "specific searchable phrase"}, headers=session()
    ).json()
    assert result["documentIds"] == [doc["id"]]
    assert client.get("/api/v1/information/search", params={"q": "%"}, headers=session()).json()[
        "documentIds"
    ] == [doc["id"]]
    assert (
        client.get(
            "/api/v1/information/search", params={"q": "nonexistent%"}, headers=session()
        ).json()["documentIds"]
        == []
    )
    assert (
        client.get(
            f'/api/v1/information/documents/{doc["id"]}/versions/{version["id"]}', headers=session()
        )
        .json()["text"]
        .startswith("specific")
    )


def test_retry_refuses_when_worker_disabled(live, monkeypatch):
    client, db, session, role = live
    monkeypatch.setattr(settings, "INFORMATION_WORKER_ENABLED", False)
    response = client.post(
        "/api/v1/information/documents/unknown/retry",
        headers={**session(), "Origin": settings.portal_origin},
    )
    assert response.status_code == 503
