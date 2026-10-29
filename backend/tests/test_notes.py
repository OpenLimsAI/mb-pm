"""Independent portal notes, ownership, concurrency and migration."""

import importlib.util
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
