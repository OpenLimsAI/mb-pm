"""Independent portal notes, ownership, concurrency and migration."""

import hashlib
import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
import test_solutions
from sqlalchemy import create_engine, inspect, select, text

from app.api.v1 import notes
from app.models.note import PersonalNote
from app.services import password_policy, solution_knowledge

solution_client = test_solutions.solution_client

PREFIX = "/api/v1/notes"


@pytest.fixture
def note_client(solution_client):
    solution_client.client.app.include_router(notes.router, prefix="/api/v1")
    session_login = solution_client.login

    def login(subject="author"):
        session_login(subject)
        # Each newly opened portal page receives its verified identity from /portal/me.
        solution_client.client.headers["X-Notes-Portal-Identity"] = notes.portal.identity_namespace(
            {
                "iss": notes.settings.casdoor_issuer,
                "owner": notes.settings.CASDOOR_ORG,
                "sub": subject,
            }
        )

    solution_client.login = login
    login()
    return solution_client


def body(**changes):
    return (
        dict(
            id=str(uuid4()),
            title="我的观察",
            content="需后续验证。",
            source_app="manual",
            source_title="",
            source_url="",
        )
        | changes
    )


def create(f, **changes):
    response = f.client.post(PREFIX, json=body(**changes))
    assert response.status_code == 201, response.text
    return response.json()


def save_body(note, **changes):
    return {
        k: v
        for k, v in note.items()
        if k in {"title", "content", "source_app", "source_title", "source_url", "revision"}
    } | changes


def test_independent_crud_and_trash_restore(note_client, monkeypatch):
    f = note_client
    monkeypatch.setattr(
        solution_knowledge,
        "configured",
        lambda: (_ for _ in ()).throw(AssertionError("KB must not be consulted")),
    )
    row = create(
        f,
        source_app="information",
        source_title="行业观察",
        source_url="https://example.org/source",
    )
    assert row["created_at"].endswith("+00:00")
    note = f.client.put(f"{PREFIX}/{row['id']}", json=save_body(row, content="个人补充思考")).json()
    assert note["revision"] == 2 and note["source_title"] == "行业观察"
    assert (
        f.client.get(PREFIX, params={"search": "补充", "source_app": "information"}).json()["total"]
        == 1
    )
    trashed = f.client.post(f"{PREFIX}/{row['id']}/trash", json={"revision": 2}).json()
    assert trashed["deleted_at"] and f.client.get(PREFIX).json()["items"] == []
    assert f.client.get(PREFIX, params={"trashed": True}).json()["total"] == 1
    assert f.client.put(f"{PREFIX}/{row['id']}", json=save_body(trashed)).status_code == 409
    restored = f.client.post(f"{PREFIX}/{row['id']}/restore", json={"revision": 3}).json()
    assert restored["deleted_at"] is None and restored["revision"] == 4
    assert f.client.get(PREFIX).json()["items"][0]["content"] == "个人补充思考"
    assert not PersonalNote.__table__.foreign_keys


def test_source_link_reads_only_own_active_note(note_client):
    f = note_client
    row = create(f)
    assert f.client.get(f"{PREFIX}/{row['id']}").json()["content"] == row["content"]
    f.login("another-person")
    assert f.client.get(f"{PREFIX}/{row['id']}").status_code == 404
    f.login("author")
    assert f.client.post(f"{PREFIX}/{row['id']}/trash", json={"revision": 1}).status_code == 200
    assert f.client.get(f"{PREFIX}/{row['id']}").status_code == 404


def test_knowledge_source_is_private_and_filterable(note_client):
    f = note_client
    row = create(f, source_app="knowledge", source_title="论文摘录", content="相关内容")
    assert (
        f.client.get(PREFIX, params={"source_app": "knowledge"}).json()["items"][0]["id"]
        == row["id"]
    )
    f.login("another-person")
    assert f.client.get(PREFIX, params={"source_app": "knowledge"}).json()["total"] == 0
    assert f.client.put(f"{PREFIX}/{row['id']}", json=save_body(row)).status_code == 404


def test_knowledge_origin_requires_matching_session_identity(note_client):
    f = note_client
    headers = {
        "Origin": notes.settings.KNOWLEDGE_NOTES_ORIGIN,
        "X-Notes-Issuer": notes.settings.casdoor_issuer,
        "X-Notes-Subject": "author",
    }
    assert f.client.get(PREFIX, headers=headers).status_code == 200
    assert (
        f.client.post(PREFIX, json=body(source_app="knowledge"), headers=headers).status_code == 201
    )
    assert f.client.get(PREFIX, headers=headers | {"X-Notes-Subject": "other"}).status_code == 403
    assert (
        f.client.get(PREFIX, headers=headers | {"X-Notes-Issuer": "https://other"}).status_code
        == 403
    )
    assert f.client.get(PREFIX, headers={"X-Notes-Identity": "wrong"}).status_code == 403


def test_portal_draft_is_not_created_under_a_new_cookie_account(note_client):
    f = note_client
    # This is the identity returned to account A's already-open PortalGate.
    identity = hashlib.sha256(
        json.dumps(
            [notes.settings.casdoor_issuer, notes.settings.CASDOOR_ORG, "author"],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    headers = {"X-Notes-Portal-Identity": identity}
    assert f.client.get(PREFIX, headers=headers).status_code == 200
    draft = body(title="账号 A 未保存草稿", content="账号 A 的私人内容")
    f.login("another-person")
    response = f.client.post(PREFIX, json=draft, headers=headers)
    assert response.status_code == 403
    assert f.client.get(PREFIX).json()["items"] == []
    assert f.db.get(PersonalNote, draft["id"]) is None
    # A can retry the same draft when the original account is restored.
    f.login("author")
    assert f.client.post(PREFIX, json=draft, headers=headers).status_code == 201


@pytest.mark.parametrize("method", ["get", "post"])
def test_notes_reject_requests_without_an_expected_identity(note_client, method):
    f = note_client
    f.client.headers.pop("X-Notes-Portal-Identity", None)
    response = getattr(f.client, method)(PREFIX, **({"json": body()} if method == "post" else {}))
    assert response.status_code == 403
    assert "刷新" in response.json()["detail"]
    assert f.db.scalar(select(PersonalNote)) is None


@pytest.mark.parametrize("mode", ["iframe", "knowledge"])
def test_existing_kb_identity_contract_remains_usable_without_portal_pin(note_client, mode):
    f = note_client
    f.client.headers.pop("X-Notes-Portal-Identity")
    if mode == "knowledge":
        headers = {
            "Origin": notes.settings.KNOWLEDGE_NOTES_ORIGIN,
            "X-Notes-Issuer": notes.settings.casdoor_issuer,
            "X-Notes-Subject": "author",
        }
    else:
        headers = {
            "X-Notes-Identity": hashlib.sha256(
                json.dumps(
                    [notes.settings.casdoor_issuer, "author"],
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
        }
    assert f.client.get(PREFIX, headers=headers).status_code == 200
    assert (
        f.client.post(PREFIX, json=body(source_app="knowledge"), headers=headers).status_code == 201
    )
    assert f.client.get(PREFIX, headers=headers).json()["total"] == 1
    f.login("another-person")
    f.client.headers.pop("X-Notes-Portal-Identity")
    assert f.client.get(PREFIX, headers=headers).status_code == 403
    assert f.client.post(PREFIX, json=body(), headers=headers).status_code == 403


@pytest.mark.parametrize(
    "method,suffix,payload",
    [
        ("get", "", None),
        ("get", "/{id}", None),
        ("put", "/{id}", "save"),
        ("post", "/{id}/trash", {"revision": 1}),
        ("post", "/{id}/restore", {"revision": 1}),
        ("post", "/{id}/wisdom", {"revision": 1, "enabled": True}),
    ],
)
def test_portal_identity_mismatch_rejects_all_note_operations(
    note_client, monkeypatch, method, suffix, payload
):
    f = note_client
    monkeypatch.setattr(notes.note_sync, "require_editor", lambda _: None)
    monkeypatch.setattr(notes.note_sync, "configured", lambda: True)
    row = create(f)
    kwargs = {"headers": {"X-Notes-Portal-Identity": "stale-account"}}
    if payload:
        kwargs["json"] = save_body(row) if payload == "save" else payload
    response = getattr(f.client, method)(PREFIX + suffix.format(id=row["id"]), **kwargs)
    assert response.status_code == 403
    assert f.client.get(f"{PREFIX}/{row['id']}").json() == row


def test_knowledge_cors_is_limited_to_notes():
    from fastapi.testclient import TestClient

    from app.main import app

    origin = notes.settings.KNOWLEDGE_NOTES_ORIGIN
    headers = {
        "Origin": origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-notes-issuer,x-notes-subject",
    }
    # Do not run the production application lifespan against the developer's database.
    client = TestClient(app)
    response = client.options(PREFIX, headers=headers)
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-credentials"] == "true"
    response = client.options("/api/v1/portal/me", headers=headers)
    assert response.headers.get("access-control-allow-origin") != origin
    response = client.options(PREFIX, headers=headers | {"Origin": "https://evil.example"})
    assert response.headers.get("access-control-allow-origin") != "https://evil.example"
    client.close()


def test_owner_and_issuer_isolation(note_client):
    f = note_client
    row = create(f)
    f.login("another-person")
    assert f.client.get(PREFIX).json()["total"] == 0
    for method, suffix, payload in [
        ("put", "", save_body(row)),
        ("post", "/trash", {"revision": 1}),
        ("post", "/restore", {"revision": 1}),
    ]:
        assert (
            getattr(f.client, method)(f"{PREFIX}/{row['id']}{suffix}", json=payload).status_code
            == 404
        )
    f.login()
    stored = f.db.scalar(select(PersonalNote))
    stored.issuer = "https://other-issuer.example"
    f.db.commit()
    assert f.client.get(PREFIX).json()["total"] == 0


def test_idempotency_and_collisions(note_client):
    f = note_client
    payload = body()
    first = f.client.post(PREFIX, json=payload).json()
    assert f.client.post(PREFIX, json=payload).json() == first
    assert f.client.get(PREFIX).json()["total"] == 1
    assert f.client.post(PREFIX, json=payload | {"content": "不同内容"}).status_code == 409
    f.login("other")
    response = f.client.post(PREFIX, json=payload)
    assert response.status_code == 409 and "我的观察" not in response.text


def test_revision_conflict_preserves_content(note_client):
    f = note_client
    row = create(f)
    latest = f.client.put(f"{PREFIX}/{row['id']}", json=save_body(row, content="最新版本")).json()
    for revision in (1, 3):
        assert (
            f.client.put(
                f"{PREFIX}/{row['id']}", json=save_body(row, revision=revision, content="过时文本")
            ).status_code
            == 409
        )
        assert (
            f.client.post(f"{PREFIX}/{row['id']}/trash", json={"revision": revision}).status_code
            == 409
        )
    assert f.client.get(PREFIX).json()["items"][0]["content"] == "最新版本"
    f.client.post(f"{PREFIX}/{row['id']}/trash", json={"revision": latest["revision"]})
    assert (
        f.client.post(
            f"{PREFIX}/{row['id']}/restore", json={"revision": latest["revision"]}
        ).status_code
        == 409
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"title": " "},
        {"content": "\n"},
        {"title": "字" * 201},
        {"content": "字" * 50001},
        {"source_app": "kb"},
        {"source_url": "javascript:alert(1)"},
        {"source_url": "//evil.example"},
        {"source_url": "https://user:password@example.org"},
        {"source_url": "/\\evil"},
        {"owner_id": "other"},
        {"id": "not-a-uuid"},
    ],
)
def test_invalid_input(note_client, changes):
    assert note_client.client.post(PREFIX, json=body(**changes)).status_code == 422
    assert note_client.client.get(PREFIX).json()["total"] == 0


def test_auth_origin_and_temporary_password(note_client):
    f = note_client
    f.client.cookies.clear()
    assert f.client.get(PREFIX).status_code == 401
    f.login()
    assert (
        f.client.post(PREFIX, json=body(), headers={"Origin": "https://other.example"}).status_code
        == 403
    )
    f.client.headers.pop("Origin")
    assert f.client.post(PREFIX, json=body()).status_code == 403
    password_policy.require_change(f.db, "author", "reset")
    f.db.commit()
    assert f.client.get(PREFIX).status_code == 403


def test_pagination_and_literal_search(note_client):
    f = note_client
    for i in range(52):
        create(f, title=f"观察{i}", content="100%记录" if i == 3 else "普通记录")
    first = f.client.get(PREFIX).json()
    second = f.client.get(PREFIX, params={"offset": 50}).json()
    assert len(first["items"]) == 50 and len(second["items"]) == 2 and first["total"] == 52
    assert not ({r["id"] for r in first["items"]} & {r["id"] for r in second["items"]})
    assert f.client.get(PREFIX, params={"search": "%"}).json()["total"] == 1
    assert f.client.get(PREFIX, params={"offset": -1}).status_code == 422


def test_migration_independent_and_repeatable():
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).parents[1] / "alembic/versions/2026_10_25_0200-009_personal_notes.py"
    spec = importlib.util.spec_from_file_location("notes_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE unrelated_legacy_notes (id INTEGER)"))
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
            info = inspect(connection)
            columns = {column["name"]: column for column in info.get_columns("personal_notes")}
            for column in PersonalNote.__table__.columns:
                assert columns[column.name]["nullable"] == column.nullable
            assert not info.get_foreign_keys("personal_notes")
            assert info.get_indexes("personal_notes")[0]["name"] == "ix_personal_notes_owner"
            module.downgrade()
            assert inspect(connection).get_table_names() == ["unrelated_legacy_notes"]
    engine.dispose()
