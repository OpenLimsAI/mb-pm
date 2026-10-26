"""信息获取原型复用门户身份，不创建 PM 账号、不注册真实采集接口。"""

import hashlib
import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.v1.portal import PORTAL_SESSION_COOKIE
from app.core import security
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import IAMIdentity, IAMSession, PortalSession, User
from app.services import password_policy


@pytest.fixture
def information_portal(token_factory):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    app.dependency_overrides[get_db] = lambda: db

    def session(**claims):
        value = f"information-{len(db.query(PortalSession).all())}"
        db.add(
            PortalSession(
                id=security.digest(value),
                expires_at=int(time.time()) + 600,
                tokens=security.seal(
                    {
                        "access_token": token_factory(
                            **{
                                "sub": "information-only",
                                "name": "information.reader",
                                "roles": [],
                                **claims,
                            }
                        )
                    }
                ),
            )
        )
        db.commit()
        return {"Cookie": f"{PORTAL_SESSION_COOKIE}={value}"}

    try:
        with TestClient(app, base_url=settings.pms_origin, follow_redirects=False) as client:
            yield client, db, session
    finally:
        app.dependency_overrides.pop(get_db, None)
        db.close()
        engine.dispose()


def test_information_entry_requires_no_pm_or_kb_account(information_portal):
    client, db, session = information_portal
    response = client.get("/api/v1/portal/me", headers=session())
    assert response.status_code == 200
    payload = response.json()
    entries = {entry["id"]: entry for entry in payload["applications"]}
    assert entries["information"] == {"id": "information", "enabled": True}
    assert entries["kb"]["enabled"] is False
    assert payload["user"]["id"] == "information-only"
    assert db.query(User).count() == 0
    assert db.query(IAMIdentity).count() == 0
    assert db.query(IAMSession).count() == 0


@pytest.mark.parametrize(
    "claims,status",
    [
        ({"owner": "foreign-organization"}, 403),
        ({"isForbidden": True}, 403),
        ({"isDeleted": True}, 403),
        ({"exp": 1}, 401),
    ],
)
def test_invalid_identity_cannot_receive_information_entry(information_portal, claims, status):
    client, _, session = information_portal
    response = client.get("/api/v1/portal/me", headers=session(**claims))
    assert response.status_code == status
    assert "applications" not in response.json()


def test_information_keeps_existing_password_change_guard(information_portal):
    client, db, session = information_portal
    headers = session()
    password_policy.require_change(db, "information-only", "temporary")
    db.commit()
    payload = client.get("/api/v1/portal/me", headers=headers).json()
    # PortalGate sees this flag before mounting any application, including the new prototype.
    assert payload["must_change_password"] is True
    assert payload["user"]["id"] == "information-only"
    assert db.query(User).count() == 0


def test_real_collection_denies_anonymous_requests_and_has_no_paid_model_api(information_portal):
    client, _, session = information_portal
    assert client.get("/api/v1/portal/me").status_code == 401
    for path in ("/api/v1/information/jobs", "/api/v1/information/sources/missing/check"):
        assert client.post(path, json={}).status_code == 401
    assert (
        client.post("/api/v1/information/analysis", headers=session(), json={}).status_code == 404
    )


def test_namespace_uses_verified_identity_and_survives_display_changes(information_portal):
    client, _, session = information_portal
    first = client.get("/api/v1/portal/me", headers=session()).json()
    changed = client.get(
        "/api/v1/portal/me",
        headers=session(
            name="information.renamed",
            displayName="修改后的姓名",
            identity_namespace="untrusted-value-from-token",
        ),
    ).json()
    expected = hashlib.sha256(
        json.dumps(
            [settings.casdoor_issuer, settings.CASDOOR_ORG, "information-only"],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert first["identity_namespace"] == changed["identity_namespace"] == expected
    assert len(expected) == 64
    assert first["user"]["username"] != changed["user"]["username"]
    assert changed["user"]["display_name"] == "修改后的姓名"
    assert "identity_namespace" not in changed["user"]


def test_namespace_separates_subjects_with_identical_display_information(information_portal):
    client, _, session = information_portal
    first = client.get("/api/v1/portal/me", headers=session()).json()
    second = client.get("/api/v1/portal/me", headers=session(sub="another-information-only")).json()
    assert first["user"]["username"] == second["user"]["username"]
    assert first["identity_namespace"] != second["identity_namespace"]
