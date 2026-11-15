"""Feedback v2 lifecycle, provenance, collaboration and data-retaining upgrades."""

import json
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import test_feedback
from sqlalchemy import create_engine, text

from app.models.feedback import (
    Feedback,
    FeedbackActivity,
    FeedbackActivityImage,
    FeedbackImage,
    FeedbackNotice,
    FeedbackVote,
)
from app.services import accounts

wall = test_feedback.wall

BASE = "/api/v1/feedback"
PNG = b"\x89PNG\r\n\x1a\nsynthetic-picture"


@pytest.fixture
def upgrade_engine():
    url = os.environ.get("TEST_DATABASE_URL", "")
    owner = None
    schema = "feedback_upgrade_" + uuid4().hex
    if url.startswith("postgresql"):
        owner = create_engine(url)
        with owner.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    else:
        engine = create_engine("sqlite://")
    yield engine
    engine.dispose()
    if owner:
        with owner.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        owner.dispose()


def create(client, description="搜索结果不完整", **fields):
    response = client.post(
        BASE, data={"category": "bug", "description": description, "application": "kb", **fields}
    )
    assert response.status_code == 201, response.text
    return response.json()


def post(client, item, action, payload):
    return client.post(f"{BASE}/{item['id']}/{action}", json=payload)


def test_context_short_numbers_and_idempotent_create(wall):
    client, login, db = wall
    login("reporter")
    context = {
        "application": "kb",
        "path": "/?token=private#notes",
        "browser": "Firefox test",
        "captured_at": "2026-11-04T10:00:00Z",
    }
    item = create(
        client,
        source_context=json.dumps(context),
        request_id="draft-one",
        steps_to_reproduce="输入关键词",
    )
    retry = create(
        client,
        source_context=json.dumps(context),
        request_id="draft-one",
        steps_to_reproduce="输入关键词",
    )
    assert item["id"] == retry["id"] and item["number"] == "FB-0001"
    assert item["workflow_version"] == 2 and item["source_context"]["path"] == "/#notes"
    assert item["steps_to_reproduce"] == "输入关键词"
    assert client.get(BASE + "/" + item["number"]).json()["id"] == item["id"]
    assert (
        client.post(
            BASE,
            data={
                "category": "bug",
                "description": "different",
                "application": "kb",
                "request_id": "draft-one",
            },
        ).status_code
        == 409
    )
    assert db.query(Feedback).count() == 1
    for context in (
        {"path": "//evil.test"},
        {"path": "/api/v1/auth/callback?code=secret"},
        {"path": "/bad\\path"},
        {"application": []},
        {"browser": "bad\nvalue"},
    ):
        assert (
            client.post(
                BASE,
                data={
                    "category": "bug",
                    "description": "unsafe",
                    "source_context": json.dumps(context),
                },
            ).status_code
            == 422
        )
    other = Feedback(
        id="foreign",
        issuer="https://another.example",
        author_id="reporter",
        author_name="Other",
        category="bug",
        description="private",
        status="open",
        issue_number=77,
    )
    db.add(other)
    db.commit()
    assert client.get(BASE + "/FB-0077").status_code == 404


def test_any_member_can_resolve_and_reopen_without_assignment_or_verification(wall):
    client, login, db = wall
    login("reporter")
    item = create(client)
    login("handler")
    available = client.get(BASE + "/" + item["id"]).json()
    assert available["can_update_status"] is True and available["can_manage"] is False
    result = client.patch(BASE + "/" + item["id"], json={"status": "fixed"})
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "fixed" and result.json()["can_verify"] is False
    row = db.get(Feedback, item["id"])
    assert row.assignee_id is None and row.resolved_at is not None
    assert row.resolution == row.verification_steps == row.release_version == ""
    event = db.query(FeedbackActivity).filter_by(feedback_id=item["id"]).one()
    assert (event.author_id, event.kind, event.from_status, event.to_status) == (
        "handler",
        "status",
        "open",
        "fixed",
    )
    # Simplifying status writes does not grant editing, deletion or assignment.
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/content", json={"description": "forged"}
        ).status_code
        == 403
    )
    assert (
        client.patch(BASE + "/" + item["id"] + "/management", json={"priority": "p0"}).status_code
        == 403
    )
    assert client.delete(BASE + "/" + item["id"]).status_code == 403
    login("reporter")
    notices = client.get(BASE + "/notifications?unread_only=true").json()
    assert notices["unread_count"] == 1
    metrics = client.get(BASE + "/workbench").json()
    assert metrics["metrics"]["fixed"] == 1 and metrics["metrics"]["resolution_count"] == 1
    assert metrics["metrics"]["first_response_count"] == 1
    assert post(client, item, "read", {}).json()["unread_count"] == 0
    login("another-member")
    assert client.get(BASE + "/" + item["id"]).json()["can_reopen"] is True
    reopened = client.patch(BASE + "/" + item["id"], json={"status": "open"})
    assert reopened.status_code == 200 and reopened.json()["status"] == "open"
    assert db.get(Feedback, item["id"]).resolved_at is None


def test_saved_transition_inputs_are_compatible_and_retry_does_not_reclose(wall):
    client, login, db = wall
    login("reporter")
    item = create(client)
    login("handler")
    payload = {"status": "ready", "request_id": "old-draft-fix"}
    first = post(client, item, "transition", payload)
    assert first.status_code == 201, first.text
    assert first.json()["feedback"]["status"] == "fixed"
    assert first.json()["activity"]["kind"] == "status"
    assert first.json()["activity"]["to_status"] == "fixed"
    assert db.get(Feedback, item["id"]).verification_steps == ""
    login("someone-else")
    assert client.patch(BASE + "/" + item["id"], json={"status": "open"}).status_code == 200
    login("handler")
    retry = post(client, item, "transition", payload)
    assert retry.status_code == 201 and retry.json()["feedback"]["status"] == "open"
    assert first.json()["activity"]["id"] == retry.json()["activity"]["id"]
    assert (
        post(client, item, "transition", {"status": "released"}).json()["feedback"]["status"]
        == "fixed"
    )
    assert db.get(Feedback, item["id"]).release_version == ""


@pytest.mark.parametrize(
    "stored,displayed",
    [
        ("open", "open"),
        ("in_progress", "open"),
        ("ready", "fixed"),
        ("released", "fixed"),
        ("fixed", "fixed"),
    ],
)
def test_historical_status_reads_are_normalized_without_rewriting_records(wall, stored, displayed):
    client, login, db = wall
    login("reporter")
    item = create(client)
    row = db.get(Feedback, item["id"])
    row.status = stored
    row.resolution = "保留旧修复说明"
    row.verification_steps = "保留旧验证信息"
    row.release_version = "历史版本"
    db.commit()
    login("other-member")
    response = client.get(BASE + "/" + item["id"]).json()
    assert response["status"] == displayed and response["can_update_status"] is True
    assert response["can_verify"] is False
    assert client.get(BASE).json()[0]["status"] == displayed
    assert client.get(BASE + "/" + item["id"] + "/activities").json()["items"] == []
    assert db.get(Feedback, item["id"]).status == stored
    assert row.resolved_at is None and row.resolution == "保留旧修复说明"
    assert row.verification_steps == "保留旧验证信息" and row.release_version == "历史版本"
    # A plain reply retains historical raw status; no validation record is invented.
    result = post(client, item, "replies", {"body": "补充说明"})
    assert result.status_code == 201 and result.json()["feedback"]["status"] == displayed
    assert db.get(Feedback, item["id"]).status == stored and row.resolved_at is None


def test_legacy_closed_statuses_are_counted_without_fabricated_resolution_times(wall):
    client, login, db = wall
    login("reporter")
    raw = {}
    for status in ("open", "in_progress", "ready", "released", "fixed"):
        item = create(client, description=status)
        row = db.get(Feedback, item["id"])
        row.status = status
        row.due_at = datetime.now(UTC) - timedelta(days=1)
        raw[row.id] = status
    db.commit()
    metrics = client.get(BASE + "/workbench").json()
    assert metrics["metrics"]["open"] == 2 and metrics["metrics"]["fixed"] == 3
    assert metrics["metrics"]["unassigned"] == 2 and metrics["metrics"]["overdue"] == 2
    assert metrics["metrics"]["resolution_count"] == 0
    assert metrics["by_application"][0]["pending"] == 2
    assert all(db.get(Feedback, ident).status == status for ident, status in raw.items())


def test_edit_history_and_reply_images_are_retained_private_and_retry_safe(wall, monkeypatch):
    client, login, db = wall
    login("reporter")
    result = client.post(
        BASE,
        data={"category": "bug", "description": "original", "application": "pm"},
        files={"images": ("one.png", PNG, "image/png")},
    )
    item = result.json()
    old_image = item["images"][0]
    login("other")
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/content", json={"description": "tamper"}
        ).status_code
        == 403
    )
    login("reporter")
    result = client.patch(
        BASE + "/" + item["id"] + "/content-with-images",
        data={
            "description": "corrected",
            "application": "kb",
            "keep_images": "[]",
            "expected_revision": str(item["revision"]),
        },
        files={"images": ("two.png", PNG + b"new", "image/png")},
    )
    assert result.status_code == 200, result.text
    revised = result.json()
    assert revised["description"] == "corrected" and old_image not in revised["images"]
    assert client.get(BASE + "/images/" + old_image).content == PNG
    history = client.get(BASE + "/" + item["id"] + "/activities").json()["items"]
    assert (
        history[-1]["kind"] == "edit"
        and history[-1]["details"]["before"]["description"] == "original"
    )
    assert history[-1]["details"]["before"]["images"] == [old_image]
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/content",
            json={"description": "stale", "expected_revision": item["revision"]},
        ).status_code
        == 409
    )
    files = {"images": ("reply.png", PNG, "image/png")}
    data = {"body": "截图补充", "request_id": "image-reply"}
    one = client.post(BASE + "/" + item["id"] + "/replies-with-images", data=data, files=files)
    assert one.status_code == 201, one.text
    two = client.post(BASE + "/" + item["id"] + "/replies-with-images", data=data, files=files)
    assert one.json()["activity"]["id"] == two.json()["activity"]["id"]
    image = one.json()["activity"]["images"][0]
    assert client.get(BASE + "/images/" + image).content == PNG
    assert db.query(FeedbackActivityImage).count() == 1
    client.cookies.clear()
    assert client.get(BASE + "/images/" + image).status_code == 401
    login("reporter")
    assert client.delete(BASE + "/" + item["id"]).status_code == 204
    assert db.query(FeedbackActivityImage).count() == 0 and db.query(FeedbackNotice).count() == 0
    assert db.query(FeedbackImage).count() == 0


def test_votes_watches_assignment_overdue_reminders_and_unread_are_private(wall, monkeypatch):
    client, login, db = wall
    login("reporter")
    item = create(client)
    login("colleague")
    for _ in range(2):
        assert (
            client.put(BASE + "/" + item["id"] + "/vote", json={"enabled": True}).json()[
                "vote_count"
            ]
            == 1
        )
    assert db.query(FeedbackVote).count() == 1
    assert (
        client.put(BASE + "/" + item["id"] + "/follow", json={"enabled": True}).json()[
            "is_following"
        ]
        is True
    )
    assert post(client, item, "claim", {}).status_code == 200
    login("other")
    assert post(client, item, "claim", {}).status_code == 409
    assert (
        client.patch(BASE + "/" + item["id"] + "/management", json={"priority": "p0"}).status_code
        == 403
    )
    assert client.get(BASE + "/notifications").json()["unread_count"] == 0
    login("colleague")
    due = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    changed = client.patch(
        BASE + "/" + item["id"] + "/management", json={"priority": "p0", "due_at": due}
    )
    assert changed.status_code == 200 and changed.json()["is_overdue"] is True
    login("reporter")
    assert client.get(BASE + "/" + item["id"]).json()["can_unclaim"] is False
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/management", json={"assignee_id": None}
        ).status_code
        == 403
    )
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/management", json={"assignee_id": "reporter"}
        ).status_code
        == 409
    )
    assert post(client, item, "remind", {"request_id": "remind-once"}).status_code == 201
    assert post(client, item, "remind", {"request_id": "remind-once"}).status_code == 201
    assert post(client, item, "remind", {"request_id": "new-reminder"}).status_code == 429
    assert client.get(BASE + "/workbench").json()["metrics"]["overdue"] == 1
    login("colleague")
    notice = client.get(BASE + "/notifications").json()
    assert notice["unread_count"] >= 1
    login("other")
    assert client.post(BASE + "/notifications/read", json={"all": True}).json()["unread_count"] == 0
    login("colleague")
    assert client.get(BASE + "/notifications").json()["unread_count"] == notice["unread_count"]
    assert client.post(BASE + "/notifications/read", json={"all": True}).json()["unread_count"] == 0
    login("admin", role="admin")
    monkeypatch.setattr(accounts, "live_roles", lambda subject: set())
    assert client.get(BASE + "/" + item["id"]).json()["can_assign"] is False
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/content", json={"description": "forged-admin"}
        ).status_code
        == 403
    )


def test_similar_and_legacy_upgrade_do_not_invent_closed_history(wall):
    client, login, db = wall
    login("reporter")
    item = create(client)
    response = client.post(
        BASE + "/similar", json={"description": "搜索结果不完整", "application": "kb"}
    )
    assert response.json()["items"][0]["id"] == item["id"]
    legacy = db.get(Feedback, item["id"])
    legacy.workflow_version = 1
    legacy.status = "in_progress"
    db.commit()
    result = post(
        client,
        item,
        "transition",
        {"status": "ready", "resolution": "修复", "verification_steps": "验证"},
    )
    assert result.status_code == 201 and result.json()["feedback"]["workflow_version"] == 1
    assert result.json()["feedback"]["status"] == "fixed"
    old = Feedback(
        id="old-fixed",
        issuer=legacy.issuer,
        author_id="reporter",
        author_name="Reporter",
        category="bug",
        description="old fixed",
        status="fixed",
    )
    db.add(old)
    db.commit()
    assert client.get(BASE + "/old-fixed").json()["workflow_version"] == 1
    assert db.query(FeedbackActivity).filter_by(feedback_id="old-fixed").count() == 0
    assert client.get(BASE + "/workbench").json()["metrics"]["resolution_count"] == 1
    assert client.get(BASE + "/old-fixed").json()["can_reopen"] is True
    login("other")
    assert client.get(BASE + "/old-fixed").json()["can_claim"] is False
    assert post(client, {"id": "old-fixed"}, "claim", {}).status_code == 403
    login("reporter")
    reopened = post(
        client, {"id": "old-fixed"}, "transition", {"status": "in_progress", "note": "问题再次出现"}
    )
    assert reopened.status_code == 201
    assert reopened.json()["feedback"]["workflow_version"] == 1
    assert reopened.json()["feedback"]["status"] == "open"
    assert reopened.json()["activity"]["details"]["before"]["workflow_version"] == 1


def test_people_uses_current_organization_directory_without_private_account_fields(
    wall, monkeypatch
):
    from app.api.v1 import feedback
    from app.core.config import settings
    from app.services.iam_admin import IAMError

    client, login, db = wall
    login("reporter")
    item = create(client)
    users = [
        {
            "id": "new-colleague",
            "owner": settings.CASDOOR_ORG,
            "name": "new",
            "displayName": "从未反馈过的同事",
            "email": "private@example.com",
            "roles": ["admin"],
        },
        {"id": "disabled", "owner": settings.CASDOOR_ORG, "isForbidden": True},
        {"id": "foreign", "owner": "other-org"},
    ]
    monkeypatch.setattr(feedback.iam_admin, "list_users", lambda: users)
    assert client.get(BASE + "/people").json() == {
        "items": [{"id": "new-colleague", "name": "从未反馈过的同事"}]
    }
    login("admin", role="admin")
    monkeypatch.setattr(accounts, "live_roles", lambda subject: {"admin"})
    assert client.get(BASE + "/" + item["id"]).json()["can_assign"] is True
    result = client.patch(
        BASE + "/" + item["id"] + "/management", json={"assignee_id": "new-colleague"}
    )
    assert result.status_code == 200 and result.json()["assignee_name"] == "从未反馈过的同事"
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/management", json={"assignee_id": "disabled"}
        ).status_code
        == 422
    )

    def unavailable():
        raise IAMError("offline")

    monkeypatch.setattr(feedback.iam_admin, "list_users", unavailable)
    assert client.get(BASE + "/people").status_code == 503
    assert (
        client.patch(
            BASE + "/" + item["id"] + "/management", json={"assignee_id": "new-target"}
        ).status_code
        == 503
    )
    assert db.get(Feedback, item["id"]).assignee_id == "new-colleague"


def test_new_mutation_routes_are_tenant_scoped_and_context_filters_hash_auth(wall):
    client, login, db = wall
    login("reporter")
    own = create(
        client,
        source_context=json.dumps({"path": "/workspace?key=secret#/projects/p1?token=hidden"}),
    )
    assert own["source_context"]["path"] == "/workspace#/projects/p1"
    for path in (
        "/oauth/callback",
        "/OIDC/login",
        "/#/oauth/callback?token=secret",
        "/nested/callback",
    ):
        assert (
            client.post(
                BASE,
                data={
                    "category": "bug",
                    "description": "invalid",
                    "source_context": json.dumps({"path": path}),
                },
            ).status_code
            == 422
        )
    db.add(
        Feedback(
            id="foreign",
            issuer="https://foreign.example",
            author_id="reporter",
            author_name="Private",
            category="bug",
            description="Private",
            status="open",
            issue_number=100,
        )
    )
    db.commit()
    for method, suffix, payload in [
        ("POST", "claim", {}),
        ("PATCH", "management", {"priority": "p1"}),
        ("PATCH", "content", {"description": "tamper"}),
        ("POST", "transition", {"status": "in_progress"}),
        ("PUT", "vote", {"enabled": True}),
        ("PUT", "follow", {"enabled": True}),
        ("POST", "read", {}),
        ("POST", "remind", {}),
    ]:
        assert client.request(method, BASE + "/foreign/" + suffix, json=payload).status_code == 404
    assert client.get(BASE + "/foreign").status_code == 404
    assert client.get(BASE + "/FB-0100").status_code == 404
    assert all(item["id"] != "foreign" for item in client.get(BASE + "/workbench").json()["items"])


def test_workflow_schema_upgrade_numbers_old_rows_without_changing_old_values(
    monkeypatch, upgrade_engine
):
    import importlib.util
    from pathlib import Path

    from sqlalchemy import inspect, text

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from app import main
    from app.db import upgrade
    from app.db.base import Base

    def load(filename):
        path = Path(__file__).parents[1] / "alembic/versions" / filename
        spec = importlib.util.spec_from_file_location(filename, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    old = load("2026_11_04_0100-021_feedback_activities.py")
    app = load("2026_11_04_0200-022_feedback_application.py")
    new = load("2026_11_04_0600-026_feedback_workflow.py")
    assert new.revision == "026" and new.down_revision == "025"
    engine = upgrade_engine
    with engine.begin() as connection:
        for migration in (old, app):
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
        connection.execute(
            text(
                "INSERT INTO feedback (id,issuer,author_id,author_name,category,description,status,created_at) VALUES ('later','tenant','person','Person','bug','unchanged later','fixed','2026-11-04'),('earlier','tenant','person','Person','bug','unchanged earlier','open','2026-11-03'),('other','other-tenant','person','Person','bug','other tenant','fixed','2026-11-04')"
            )
        )
        baseline = connection.execute(
            text(
                "SELECT id,issuer,author_id,author_name,category,description,status,created_at,application FROM feedback ORDER BY id"
            )
        ).all()
        new.op = Operations(MigrationContext.configure(connection))
        new.upgrade()
        new.upgrade()
        new.downgrade()
        assert (
            connection.execute(
                text(
                    "SELECT id,issuer,author_id,author_name,category,description,status,created_at,application FROM feedback ORDER BY id"
                )
            ).all()
            == baseline
        )
        numbers = dict(connection.execute(text("SELECT id,issue_number FROM feedback")).all())
        assert numbers == {"earlier": 1, "later": 2, "other": 1}
        assert connection.scalar(text("SELECT COUNT(*) FROM feedback_activities")) == 0
        assert (
            connection.scalar(text("SELECT COUNT(*) FROM feedback WHERE workflow_version=1")) == 3
        )
        assert {
            "feedback_counters",
            "feedback_votes",
            "feedback_watches",
            "feedback_reads",
            "feedback_notices",
            "feedback_activity_images",
        } <= set(inspect(connection).get_table_names())
    Base.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(upgrade, "engine", engine)
    upgrade.main(schema_only=True)
    upgrade.main(schema_only=True)
    with engine.connect() as connection:
        assert (
            dict(connection.execute(text("SELECT id,issue_number FROM feedback")).all()) == numbers
        )


def test_postgres_parallel_create_keys_and_short_numbers_are_unique(client):
    import concurrent.futures

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.v1 import feedback
    from app.db.session import SessionLocal, engine, get_db
    from app.models.feedback import FeedbackCounter

    if engine.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL counter locking; exercised in CI")
    issuer = "feedback-number-" + uuid4().hex
    claims = {"iss": issuer, "sub": "author", "name": "Author"}
    app = FastAPI()
    app.include_router(feedback.router, prefix="/api/v1")

    def sessions():
        with SessionLocal() as db:
            yield db

    app.dependency_overrides[get_db] = sessions
    app.dependency_overrides[feedback.identity] = lambda: claims

    def submit(key):
        with TestClient(app) as browser:
            return browser.post(
                BASE,
                data={"category": "bug", "description": "Concurrent " + key, "request_id": key},
            )

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(submit, [str(i % 6) for i in range(12)]))
        assert all(response.status_code == 201 for response in responses), [
            response.text for response in responses
        ]
        items = [response.json() for response in responses]
        assert len({item["id"] for item in items}) == 6
        assert len({item["number"] for item in items}) == 6
        for index in range(6):
            assert items[index]["id"] == items[index + 6]["id"]
        with SessionLocal() as db:
            assert db.query(Feedback).filter_by(issuer=issuer).count() == 6
    finally:
        with SessionLocal() as db:
            for row in db.query(Feedback).filter_by(issuer=issuer):
                db.delete(row)
            counter = db.get(FeedbackCounter, issuer)
            if counter:
                db.delete(counter)
            db.commit()


def test_claim_and_activity_subscriptions_match_production_non_autoflush_sessions(wall):
    from app.models.feedback import FeedbackWatch

    client, login, db = wall
    assert db.autoflush is False
    login("reporter")
    item = create(client)
    login("handler")
    claimed = post(client, item, "claim", {})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["is_following"] is True
    first_history_count = db.query(FeedbackActivity).filter_by(feedback_id=item["id"]).count()
    assert post(client, item, "claim", {}).status_code == 200
    assert (
        db.query(FeedbackActivity).filter_by(feedback_id=item["id"]).count() == first_history_count
    )
    assert db.query(FeedbackWatch).filter_by(feedback_id=item["id"], subject="handler").count() == 1
    assert client.get(BASE + "/notifications").json()["unread_count"] == 0
    login("reporter")
    assert client.get(BASE + "/notifications").json()["unread_count"] == 1
    login("colleague")
    reply = post(client, item, "replies", {"body": "补充复现信息", "request_id": "new-watcher"})
    assert reply.status_code == 201, reply.text
    assert reply.json()["feedback"]["is_following"] is True
    assert (
        db.query(FeedbackWatch).filter_by(feedback_id=item["id"], subject="colleague").count() == 1
    )
    assert client.get(BASE + "/notifications").json()["unread_count"] == 0
    assert (
        client.put(BASE + "/" + item["id"] + "/follow", json={"enabled": False}).status_code == 200
    )
    reply = post(client, item, "replies", {"body": "再次补充，但保持取消关注"})
    assert reply.status_code == 201
    assert reply.json()["feedback"]["is_following"] is False
    assert (
        db.query(FeedbackWatch).filter_by(feedback_id=item["id"], subject="colleague").count() == 1
    )
    login("handler")
    assert client.get(BASE + "/notifications").json()["unread_count"] == 2
    login("reporter")
    assert client.get(BASE + "/notifications").json()["unread_count"] == 3
