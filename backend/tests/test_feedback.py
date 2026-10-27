"""Feedback identity, persistence, validation, attachments and status changes."""

import time
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from app.api.v1 import feedback, portal
from app.core import security
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models import PortalSession


@pytest.fixture
def wall(token_factory):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    app = FastAPI()
    app.include_router(feedback.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, base_url=settings.portal_origin) as client:
        client.headers["Origin"] = settings.portal_origin

        def login(name):
            session = "feedback-" + name
            token = token_factory(sub=name, name=name, displayName=name.upper())
            db.merge(
                PortalSession(
                    id=security.digest(session),
                    tokens=security.seal({"access_token": token}),
                    expires_at=int(time.time()) + 3600,
                )
            )
            db.commit()
            client.cookies.set(portal.PORTAL_SESSION_COOKIE, session)

        yield client, login, db
    db.close()
    engine.dispose()


def test_feedback_lifecycle_and_access(wall):
    client, login, db = wall
    url = "/api/v1/feedback"
    assert client.get(url).status_code == 401
    login("author")
    image = b"\x89PNG\r\n\x1a\n" + b"image contents"
    response = client.post(
        url,
        data={"category": "bug", "description": "  按钮无法使用  "},
        files=[("images", ("screen.png", image, "image/png"))],
    )
    assert response.status_code == 201, response.text
    item = response.json()
    assert (item["description"], item["status"], item["author_name"]) == (
        "按钮无法使用",
        "open",
        "AUTHOR",
    )
    db.expire_all()
    login("colleague")
    assert client.get(url).json()[0]["id"] == item["id"]
    pic = client.get(url + "/images/" + item["images"][0])
    assert pic.content == image and pic.headers["content-type"] == "image/png"
    assert (
        client.patch(url + "/" + item["id"], json={"status": "fixed"}).json()["status"] == "fixed"
    )
    assert client.patch(url + "/" + item["id"], json={"status": "open"}).json()["status"] == "open"
    assert client.patch(url + "/" + item["id"], json={"status": "invalid"}).status_code == 422
    assert client.patch(url + "/missing", json={"status": "fixed"}).status_code == 404
    client.headers["Origin"] = "https://elsewhere.example"
    assert client.patch(url + "/" + item["id"], json={"status": "fixed"}).status_code == 403


def test_feedback_validation_is_atomic(wall):
    client, login, _ = wall
    login("author")
    url = "/api/v1/feedback"
    assert client.post(url, data={"category": "feature", "description": "  "}).status_code == 422
    assert client.post(url, data={"category": "other", "description": "test"}).status_code == 422
    assert (
        client.post(
            url,
            data={"category": "feature", "description": "test"},
            files=[("images", ("bad.png", b"not an image", "image/png"))],
        ).status_code
        == 422
    )
    assert (
        client.post(
            url,
            data={"category": "feature", "description": "test"},
            files=[
                (
                    "images",
                    ("big.png", b"\x89PNG\r\n\x1a\n" + b"x" * (5 * 1024 * 1024), "image/png"),
                )
            ],
        ).status_code
        == 413
    )
    assert client.get(url).json() == []


def test_real_app_persists_feedback_with_or_without_attachment(client, token_factory):
    """Exercises the actual app and configured test database (PostgreSQL in CI)."""
    from uuid import uuid4
    from app.db.session import SessionLocal
    from app.models.feedback import Feedback

    name = "feedback-integration-" + uuid4().hex
    session = name + "-session"
    token = token_factory(sub=name, name=name)
    db = SessionLocal()
    db.add(
        PortalSession(
            id=security.digest(session),
            tokens=security.seal({"access_token": token}),
            expires_at=int(time.time()) + 3600,
        )
    )
    db.commit()
    ids = []
    headers = {"Origin": settings.portal_origin}
    cookies = {portal.PORTAL_SESSION_COOKIE: session}
    try:
        result = client.post(
            "/api/v1/feedback",
            data={"category": "feature", "description": "integration"},
            headers=headers,
            cookies=cookies,
        )
        assert result.status_code == 201, result.text
        ids.append(result.json()["id"])
        assert result.json()["images"] == []
        picture = b"\xff\xd8\xff" + b"test-image"
        result = client.post(
            "/api/v1/feedback",
            data={"category": "bug", "description": "with photo"},
            files={"images": ("photo.jpg", picture, "image/jpeg")},
            headers=headers,
            cookies=cookies,
        )
        assert result.status_code == 201, result.text
        ids.append(result.json()["id"])
        image_id = result.json()["images"][0]
        assert client.get("/api/v1/feedback/images/" + image_id, cookies=cookies).content == picture
        assert (
            client.patch(
                "/api/v1/feedback/" + ids[-1],
                json={"status": "fixed"},
                headers=headers,
                cookies=cookies,
            ).json()["status"]
            == "fixed"
        )
        db.expire_all()
        assert db.get(Feedback, ids[-1]).status == "fixed"
    finally:
        for item_id in ids:
            row = db.get(Feedback, item_id)
            if row:
                db.delete(row)
        session_row = db.get(PortalSession, security.digest(session))
        if session_row:
            db.delete(session_row)
        db.commit()
        db.close()
