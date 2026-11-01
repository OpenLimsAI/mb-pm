"""Retirement blocks collection without mutating retained papers or task state."""

from unittest.mock import Mock

from test_information_portal import information_portal  # noqa: F401

from app.core.config import Settings, settings
from app.services import iam_admin
from app.services.information import worker
from app.services.information.store import Store, tenant_key


def test_information_retired_by_default():
    assert Settings(_env_file=None).INFORMATION_APP_ENABLED is False


def test_retirement_blocks_api_and_preserves_records(information_portal, monkeypatch):
    client, db, session = information_portal
    store = Store(db, tenant_key(settings.casdoor_issuer, settings.CASDOOR_ORG))
    source = store.ensure_source()
    source["enabled"] = True
    store.put("source", source)
    db.commit()
    before = store.source(source["id"])
    monkeypatch.setattr(settings, "INFORMATION_APP_ENABLED", False)
    headers = {**session(), "Origin": settings.portal_origin}
    entry = next(
        v
        for v in client.get("/api/v1/portal/me", headers=headers).json()["applications"]
        if v["id"] == "information"
    )
    assert entry["enabled"] is False and "已下线" in entry["reason"]
    assert client.get("/api/v1/information/snapshot").status_code == 401
    assert client.get("/api/v1/information/snapshot", headers=headers).status_code == 410
    assert (
        client.post(
            f'/api/v1/information/sources/{source["id"]}/check', headers=headers
        ).status_code
        == 410
    )
    assert (
        client.post(
            "/api/v1/information/jobs",
            headers=headers,
            json={
                "sourceId": source["id"],
                "documentIds": [],
                "folderId": "information-archive",
                "parse": False,
            },
        ).status_code
        == 410
    )
    assert store.source(source["id"]) == before
    assert store.records("job") == []


def test_retirement_stops_tick_before_database_or_network(monkeypatch):
    monkeypatch.setattr(settings, "INFORMATION_APP_ENABLED", False)
    monkeypatch.setattr(settings, "INFORMATION_WORKER_ENABLED", True)
    session_factory, official_factory = Mock(), Mock()
    worker.tick(session_factory=session_factory, official_factory=official_factory)
    session_factory.assert_not_called()
    official_factory.assert_not_called()


def test_existing_original_stays_protected_and_readable(information_portal, monkeypatch, tmp_path):
    from app.services.information.ich import parse_catalogue
    from test_information_live import catalogue

    client, db, session = information_portal
    monkeypatch.setattr(settings, "INFORMATION_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        iam_admin,
        "get_user_by_sub",
        lambda subject: {
            "id": subject,
            "owner": settings.CASDOOR_ORG,
            "name": "archive.reader",
            "roles": [],
        },
    )
    store = Store(db, tenant_key(settings.casdoor_issuer, settings.CASDOOR_ORG))
    source = store.ensure_source()
    store.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    doc = store.documents()[0]
    original = b"%PDF-existing-original-retained"
    version = store.archive(doc["id"], original, "existing text", parse_status="ready")
    db.commit()
    monkeypatch.setattr(settings, "INFORMATION_APP_ENABLED", False)
    path = version["archiveUrl"]
    assert client.get(path).status_code == 401
    response = client.get(path, headers=session())
    assert response.status_code == 200 and response.content == original
    assert response.headers["cache-control"] == "no-store"
    assert client.get(path.replace(doc["id"], "a" * 64), headers=session()).status_code == 404
    assert client.get("/api/v1/information/snapshot", headers=session()).status_code == 410
