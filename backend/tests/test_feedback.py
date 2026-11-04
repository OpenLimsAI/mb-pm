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
from app.models.feedback import Feedback, FeedbackImage
from app.services import accounts
from app.services.iam_admin import IAMError


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

        def login(name, role="member", **claims):
            session = "feedback-" + name
            token = token_factory(
                role=role, sub=name, name=name, displayName=name.upper(), **claims
            )
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
    assert (
        client.post(url, data={"category": "feature", "description": "invalid\x00text"}).status_code
        == 422
    )
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
        reply_url = "/api/v1/feedback/" + ids[-1] + "/replies"
        payload = {"body": "修复说明，等待确认", "request_id": "integration-reply"}
        discussion = client.post(reply_url, json=payload, headers=headers, cookies=cookies)
        assert discussion.status_code == 201, discussion.text
        activity_id = discussion.json()["activity"]["id"]
        retry = client.post(reply_url, json=payload, headers=headers, cookies=cookies)
        assert retry.json()["activity"]["id"] == activity_id
        assert retry.json()["feedback"]["reply_count"] == 1
        history = client.get("/api/v1/feedback/" + ids[-1] + "/activities", cookies=cookies).json()
        assert len(history["items"]) == 2
        assert history["feedback"]["status"] == "fixed"
        assert (
            client.delete(
                "/api/v1/feedback/" + ids[-1], headers=headers, cookies=cookies
            ).status_code
            == 204
        )
        db.expire_all()
        assert db.get(Feedback, ids[-1]) is None
        assert db.get(FeedbackImage, image_id) is None
        from app.models.feedback import FeedbackActivity

        assert db.get(FeedbackActivity, activity_id) is None
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


def test_author_can_delete_own_feedback_and_images_with_same_origin(wall):
    client, login, db = wall
    url = "/api/v1/feedback"
    login("author")
    image = b"\x89PNG\r\n\x1a\n" + b"content"
    response = client.post(
        url,
        data={"category": "bug", "description": "问题详情"},
        files=[("images", ("screen.png", image, "image/png"))],
    )
    assert response.status_code == 201
    item = response.json()
    assert item["can_delete"] is True
    item_url = url + "/" + item["id"]
    assert client.get(url).json()[0]["can_delete"] is True
    client.headers["Origin"] = "https://elsewhere.example"
    assert client.delete(item_url).status_code == 403
    client.headers["Origin"] = settings.portal_origin
    assert client.delete(item_url).status_code == 204
    assert client.delete(item_url).status_code == 404
    assert client.get(url + "/images/" + item["images"][0]).status_code == 404
    db.expire_all()
    assert db.get(Feedback, item["id"]) is None
    assert db.get(FeedbackImage, item["images"][0]) is None
    client.cookies.clear()
    assert client.delete(item_url).status_code == 401


def test_other_member_cannot_delete_or_spoof_admin(wall, monkeypatch):
    client, login, db = wall
    url = "/api/v1/feedback"
    login("author")
    item = client.post(url, data={"category": "feature", "description": "请加筛选"}).json()
    item_url = url + "/" + item["id"]
    live_calls = []
    monkeypatch.setattr(accounts, "live_roles", lambda name: live_calls.append(name) or {"admin"})
    login("other")
    assert client.get(url).json()[0]["can_delete"] is False
    assert (
        client.request(
            "DELETE", item_url, json={"author_id": "author", "role": "admin"}
        ).status_code
        == 403
    )
    assert live_calls == []
    login("other", roles=[{"owner": "another-org", "name": "admin", "isEnabled": True}])
    assert client.get(url).json()[0]["can_delete"] is False
    assert client.delete(item_url).status_code == 403
    login("other", roles=[{"owner": settings.CASDOOR_ORG, "name": "admin", "isEnabled": False}])
    assert client.delete(item_url).status_code == 403
    assert live_calls == []
    db.expire_all()
    assert db.get(Feedback, item["id"]) is not None


def test_admin_delete_requires_live_permissions_and_tenant(wall, monkeypatch):
    client, login, db = wall
    url = "/api/v1/feedback"
    login("author")
    item = client.post(
        url,
        data={"category": "bug", "description": "跨成员协作"},
        files=[("images", ("photo.jpg", b"\xff\xd8\xff" + b"contents", "image/jpeg"))],
    ).json()
    item_url = url + "/" + item["id"]
    login("administrator", role="admin")
    assert client.get(url).json()[0]["can_delete"] is True
    monkeypatch.setattr(accounts, "live_roles", lambda subject: set())
    assert client.delete(item_url).status_code == 403

    def unavailable(subject):
        raise IAMError("IAM unavailable")

    monkeypatch.setattr(accounts, "live_roles", unavailable)
    assert client.delete(item_url).status_code == 503
    db.expire_all()
    assert db.get(Feedback, item["id"]) is not None
    assert db.get(FeedbackImage, item["images"][0]) is not None
    monkeypatch.setattr(accounts, "live_roles", lambda subject: {"admin"})
    foreign = Feedback(
        id="foreign-record",
        issuer="https://other.example",
        author_id="administrator",
        author_name="other",
        category="bug",
        description="other tenant",
        status="open",
    )
    db.add(foreign)
    db.commit()
    assert client.delete(url + "/foreign-record").status_code == 404
    assert client.delete(item_url).status_code == 204
    db.expire_all()
    assert db.get(Feedback, item["id"]) is None
    assert db.get(FeedbackImage, item["images"][0]) is None
    assert db.get(Feedback, "foreign-record") is not None


def test_discussion_reply_status_history_and_ownership(wall):
    client, login, db = wall
    login("author")
    base = "/api/v1/feedback"
    item = client.post(base, data={"category": "bug", "description": "需要处理的问题"}).json()
    url = base + "/" + item["id"]
    assert item["reply_count"] == 0 and item["is_mine"] is True
    assert item["last_activity_at"]
    page = client.get(url + "/activities").json()
    assert page["items"] == [] and page["next_cursor"] is None
    assert page["feedback"]["id"] == item["id"]
    login("repairer")
    assert client.get(base).json()[0]["is_mine"] is False
    result = client.post(
        url + "/replies", json={"body": "  已复现，正在排查  ", "status": "in_progress"}
    )
    assert result.status_code == 201, result.text
    body = result.json()
    assert body["feedback"]["status"] == "in_progress"
    assert body["feedback"]["reply_count"] == 1
    activity = body["activity"]
    assert activity["kind"] == "status" and activity["body"] == "已复现，正在排查"
    assert (activity["author_name"], activity["from_status"], activity["to_status"]) == (
        "REPAIRER",
        "open",
        "in_progress",
    )
    assert "author_id" not in activity and "client_request_id" not in activity
    result = client.patch(url, json={"status": "fixed", "note": " 已修复并验证 "})
    assert result.status_code == 200 and result.json()["reply_count"] == 2
    assert result.json()["status"] == "fixed"
    # Normal follow-up must retain the latest database status without sending a stale state.
    login("author")
    result = client.post(url + "/replies", json={"body": "谢谢，已确认"}).json()
    assert result["feedback"]["status"] == "fixed" and result["feedback"]["is_mine"] is True
    assert result["activity"]["kind"] == "comment"
    assert result["activity"]["from_status"] is None and result["activity"]["to_status"] is None
    events = client.get(url + "/activities").json()["items"]
    assert [event["body"] for event in events] == [
        "已复现，正在排查",
        "已修复并验证",
        "谢谢，已确认",
    ]
    listed = client.get(base).json()[0]
    assert listed["reply_count"] == 3
    assert listed["last_activity_at"] >= listed["created_at"]
    assert (
        client.patch(url, json={"status": "fixed", "note": "相同状态不是新处理"}).status_code == 409
    )
    assert client.patch(url, json={"status": "fixed"}).status_code == 200
    assert len(client.get(url + "/activities").json()["items"]) == 3
    assert client.patch(url, json={"status": "open"}).json()["status"] == "open"
    events = client.get(url + "/activities").json()["items"]
    assert len(events) == 4 and events[-1]["body"] == ""
    assert (events[-1]["from_status"], events[-1]["to_status"]) == ("fixed", "open")
    assert client.get(base).json()[0]["reply_count"] == 3


def test_discussion_validation_identity_and_tenant_boundaries(wall, monkeypatch):
    from starlette.requests import Request

    from app.models.feedback import FeedbackActivity

    client, login, db = wall
    login("author")
    base = "/api/v1/feedback"
    item = client.post(base, data={"category": "feature", "description": "建议"}).json()
    url = base + "/" + item["id"]
    for payload in (
        {},
        {"body": " "},
        {"body": "x" * 2001},
        {"body": "invalid\x00text"},
        {"body": "test", "request_id": "invalid\x00key"},
        {"body": 1},
        {"body": "test", "status": "unknown"},
        {"body": "test", "author_id": "other"},
        {"body": "test", "request_id": " "},
    ):
        result = client.post(url + "/replies", json=payload)
        assert result.status_code == 422, result.text
    assert client.patch(url, json={"status": "fixed", "note": "x" * 2001}).status_code == 422
    assert client.patch(url, json={"status": "fixed", "note": "invalid\x00note"}).status_code == 422
    assert (
        client.post(
            url + "/replies", content=b"{bad", headers={"Content-Type": "application/json"}
        ).status_code
        == 422
    )
    assert client.post(url + "/replies", json={"body": "x" * 17_000}).status_code == 413
    assert (
        client.post(
            url + "/replies", content="test", headers={"Content-Type": "text/plain"}
        ).status_code
        == 415
    )
    assert db.query(FeedbackActivity).count() == 0
    assert client.get(base).json()[0]["status"] == "open"
    foreign = Feedback(
        id="other-tenant",
        issuer="https://foreign.test",
        author_id="author",
        author_name="other",
        category="bug",
        description="private",
        status="fixed",
    )
    db.add(foreign)
    db.commit()
    assert client.post(base + "/other-tenant/replies", json={"body": "test"}).status_code == 404
    assert client.get(base + "/other-tenant/activities").status_code == 404
    assert client.patch(base + "/other-tenant", json={"status": "open"}).status_code == 404
    assert client.post(base + "/missing/replies", json={"body": "test"}).status_code == 404
    assert client.get(base + "/missing/activities").status_code == 404
    assert all(row["id"] != "other-tenant" for row in client.get(base).json())

    # Parsing must not run before authentication or same-origin checks.
    async def forbidden_stream(request):
        raise AssertionError("Request body was parsed before identity")
        yield b"unreachable"

    monkeypatch.setattr(Request, "stream", forbidden_stream)
    client.cookies.clear()
    assert client.post(url + "/replies", content=b"{bad").status_code == 401
    assert client.patch(url, content=b"{bad").status_code == 401
    assert client.get(url + "/activities").status_code == 401
    login("author")
    client.headers["Origin"] = "https://foreign.test"
    assert client.post(url + "/replies", content=b"{bad").status_code == 403
    assert client.patch(url, content=b"{bad").status_code == 403


def test_discussion_request_id_retries_preserve_current_state(wall):
    from app.models.feedback import FeedbackActivity

    client, login, db = wall
    login("author")
    item = client.post(
        "/api/v1/feedback", data={"category": "bug", "description": "重复提交"}
    ).json()
    url = "/api/v1/feedback/" + item["id"]
    payload = {"body": "已经修复", "status": "fixed", "request_id": "one-logical-submit"}
    original = client.post(url + "/replies", json=payload).json()
    # Another person reopens; a retry of the original reply must not reapply old status.
    login("colleague")
    client.patch(url, json={"status": "open"})
    login("author")
    retry = client.post(url + "/replies", json={**payload, "body": "  已经修复  "})
    assert retry.status_code == 201
    assert retry.json()["activity"]["id"] == original["activity"]["id"]
    assert retry.json()["feedback"]["status"] == "open"
    assert retry.json()["feedback"]["reply_count"] == 1
    assert db.query(FeedbackActivity).count() == 2
    assert client.post(url + "/replies", json={**payload, "body": "different"}).status_code == 409
    assert client.post(url + "/replies", json={**payload, "status": "open"}).status_code == 409
    login("colleague")
    assert client.post(url + "/replies", json=payload).status_code == 409
    assert db.query(FeedbackActivity).count() == 2


def test_discussion_keyset_pagination_and_delete_cascade(wall):
    from datetime import UTC, datetime

    from app.models.feedback import FeedbackActivity

    client, login, db = wall
    login("author")
    base = "/api/v1/feedback"
    one = client.post(base, data={"category": "bug", "description": "first"}).json()
    two = client.post(base, data={"category": "bug", "description": "second"}).json()
    stamp = datetime(2026, 11, 4, tzinfo=UTC)
    for number in range(123):
        db.add(
            FeedbackActivity(
                id=f"activity-{number:03}",
                feedback_id=one["id"],
                author_id="author",
                author_name="AUTHOR",
                kind="comment",
                body=f"reply {number}",
                created_at=stamp,
            )
        )
    db.add(
        FeedbackActivity(
            id="foreign-activity",
            feedback_id=two["id"],
            author_id="author",
            author_name="AUTHOR",
            kind="comment",
            body="private",
            created_at=stamp,
        )
    )
    db.commit()
    url = base + "/" + one["id"]
    assert client.get(url + "/activities?before=foreign-activity").status_code == 404
    assert client.get(url + "/activities?before=missing").status_code == 404
    page = client.get(url + "/activities").json()
    assert [event["id"] for event in page["items"]] == [f"activity-{i:03}" for i in range(73, 123)]
    assert page["next_cursor"] == "activity-073"
    second = client.get(url + "/activities", params={"before": page["next_cursor"]}).json()
    assert [event["id"] for event in second["items"]] == [f"activity-{i:03}" for i in range(23, 73)]
    third = client.get(url + "/activities", params={"before": second["next_cursor"]}).json()
    assert third["next_cursor"] is None
    all_ids = [event["id"] for event in third["items"] + second["items"] + page["items"]]
    assert len(all_ids) == len(set(all_ids)) == 123
    listed = next(item for item in client.get(base).json() if item["id"] == one["id"])
    assert listed["reply_count"] == 123 and listed["last_activity_at"] >= listed["created_at"]
    assert client.delete(url).status_code == 204
    assert db.query(FeedbackActivity).filter_by(feedback_id=one["id"]).count() == 0
    assert db.query(FeedbackActivity).filter_by(feedback_id=two["id"]).count() == 1
    assert client.get(url + "/activities").status_code == 404


def test_legacy_fixed_feedback_has_no_fabricated_activity(wall):
    client, login, db = wall
    login("author")
    db.add(
        Feedback(
            id="legacy-fixed",
            issuer=settings.casdoor_issuer,
            author_id="author",
            author_name="AUTHOR",
            category="bug",
            description="old issue",
            status="fixed",
        )
    )
    db.commit()
    item = client.get("/api/v1/feedback").json()[0]
    assert item["status"] == "fixed" and item["reply_count"] == 0
    page = client.get("/api/v1/feedback/legacy-fixed/activities").json()
    assert page["items"] == [] and page["next_cursor"] is None
    assert page["feedback"]["status"] == "fixed"


def test_feedback_migration_is_additive_on_fresh_and_existing_databases():
    import importlib.util
    from pathlib import Path

    from sqlalchemy import inspect, text

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).parents[1] / "alembic/versions/2026_11_04_0100-021_feedback_activities.py"
    spec = importlib.util.spec_from_file_location("feedback_activity_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        module.op = Operations(MigrationContext.configure(connection))
        module.upgrade()
        assert {"feedback", "feedback_images", "feedback_activities"} <= set(
            inspect(connection).get_table_names()
        )
        connection.execute(
            text(
                "INSERT INTO feedback (id,issuer,author_id,author_name,category,description,status,created_at) VALUES ('legacy','tenant','person','Person','bug','history','fixed',CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO feedback_activities (id,feedback_id,author_id,author_name,kind,body,created_at) VALUES ('activity','legacy','person','Person','comment','preserve',CURRENT_TIMESTAMP)"
            )
        )
        module.upgrade()
        module.downgrade()
        assert connection.scalar(text("SELECT status FROM feedback WHERE id='legacy'")) == "fixed"
        assert (
            connection.scalar(text("SELECT body FROM feedback_activities WHERE id='activity'"))
            == "preserve"
        )
    engine.dispose()


def test_postgres_parallel_reply_retries_are_serialized(client, monkeypatch):
    """A second connection must wait for the same feedback's first reply transaction."""
    import concurrent.futures
    import threading
    from uuid import uuid4

    from app.db.session import SessionLocal, engine
    from app.models.feedback import FeedbackActivity

    if engine.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL row locks; exercised in CI")
    ident = uuid4().hex
    claims = {"iss": "feedback-concurrency-test", "sub": "author", "name": "Author"}
    with SessionLocal() as db:
        db.add(
            Feedback(
                id=ident,
                issuer=claims["iss"],
                author_id="author",
                author_name="Author",
                category="bug",
                description="concurrency",
                status="open",
            )
        )
        db.commit()
    app = FastAPI()
    app.include_router(feedback.router, prefix="/api/v1")

    def sessions():
        with SessionLocal() as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    app.dependency_overrides[feedback.identity] = lambda: claims
    first_commit = threading.Event()
    release_first = threading.Event()
    gate_lock = threading.Lock()
    original_commit = Session.commit

    def gated_commit(db):
        if any(isinstance(row, FeedbackActivity) and row.feedback_id == ident for row in db.new):
            with gate_lock:
                first = not first_commit.is_set()
                if first:
                    first_commit.set()
            if first:
                assert release_first.wait(5), "Test did not release the first transaction"
        return original_commit(db)

    monkeypatch.setattr(Session, "commit", gated_commit)
    payload = {"body": "Fixed once", "status": "fixed", "request_id": "parallel-id"}
    try:
        with TestClient(app) as first_client, TestClient(app) as second_client:
            url = "/api/v1/feedback/" + ident + "/replies"
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                one = pool.submit(first_client.post, url, json=payload)
                try:
                    assert first_commit.wait(5), "First transaction did not reach commit"
                    two = pool.submit(second_client.post, url, json=payload)
                    with pytest.raises(concurrent.futures.TimeoutError):
                        two.result(timeout=0.2)
                finally:
                    release_first.set()
                responses = [one.result(timeout=5), two.result(timeout=5)]
            assert [response.status_code for response in responses] == [201, 201]
            assert responses[0].json()["activity"]["id"] == responses[1].json()["activity"]["id"]
        with SessionLocal() as db:
            assert db.query(FeedbackActivity).filter_by(feedback_id=ident).count() == 1
            assert db.get(Feedback, ident).status == "fixed"
    finally:
        release_first.set()
        with SessionLocal() as db:
            row = db.get(Feedback, ident)
            if row is not None:
                db.delete(row)
                db.commit()
