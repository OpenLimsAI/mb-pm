"""Delegated knowledge reads and resumable project changes, using real RSA validation."""

from datetime import UTC, datetime, timedelta

from test_agent_projects import delegated_token as shared_delegated_token

from app.core.config import settings
from app.core.security import seal, unseal
from app.db.session import SessionLocal
from app.models import IAMIdentity, Task, TaskActivity
from app.services import accounts
from app.services.information import bridge

delegated_token = shared_delegated_token
ROOT = "/api/v1/agent"


def test_agent_knowledge_checks_own_live_role_and_pins_source_pages(
    client, iam_user, delegated_token, monkeypatch
):
    uid = iam_user("agent-kb-pm-user", "admin")
    subject = "agent-kb-iam-identifier"
    with SessionLocal() as db:
        identity = db.get(IAMIdentity, (settings.casdoor_issuer, uid))
        identity.subject = subject
        db.commit()
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_APP_ENABLED", True)
    held = {"admin"}
    calls = []
    source_id = "sources/SOP-validation.md"
    version = "a" * 64
    current = version
    source = {
        "path": source_id,
        "title": "验证SOP",
        "hash": version,
        "url": "https://knowledge.example.com/paper?path=SOP-validation",
        "metadata": {"documentType": "SOP", "sourceUrl": "https://example.com/sop"},
        "source": {"scopes": ["Q"]},
        "matches": [{"field": "text", "text": "确认数据完整性"}],
        "body": "never return the whole body from search",
        "internalToken": "never expose",
    }

    def live_roles(actor):
        assert actor == subject
        return held.copy()

    def connected(operation, actor, **payload):
        assert actor == subject
        calls.append((operation, payload))
        if operation == "queryLibrary":
            assert payload == {"query": "验证", "searchMode": "all", "offset": 0, "limit": 10}
            return {"papers": [source], "nextOffset": None, "incomplete": True}
        assert operation == "readPaper" and payload["path"] == source_id
        body = "A🧪" if payload["offset"] == 0 else "B"
        return {
            **source,
            "hash": current,
            "body": body,
            "offset": payload["offset"],
            "totalLength": 4,
        }

    monkeypatch.setattr(accounts, "live_roles", live_roles)
    monkeypatch.setattr(bridge, "call", connected)
    headers = delegated_token(subject, "admin")
    search = f"{ROOT}/knowledge/search"
    read = f"{ROOT}/knowledge/read"
    assert client.get(search, params={"q": "验证"}, headers=headers).status_code == 403
    assert calls == []
    held.add("kb_viewer")
    response = client.get(search, params={"q": "验证"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["incomplete"] is True
    item = response.json()["items"][0]
    assert item["document_type"] == "SOP"
    assert item["applicability"] == ["Q"]
    assert item["source_url"] == "https://example.com/sop"
    assert item["excerpt"] == "确认数据完整性"
    assert "body" not in item and "internalToken" not in item
    assert item["version"] == version

    response = client.get(
        read, params={"source_id": source_id, "version": version, "limit": 3}, headers=headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["text"] == "A🧪"
    assert response.json()["next_offset"] == 3
    assert response.json()["position_unit"] == "utf16"
    assert (
        client.get(read, params={"source_id": source_id, "offset": 3}, headers=headers).status_code
        == 422
    )
    params = {"source_id": source_id, "version": version, "offset": 3}
    response = client.get(read, params=params, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["text"] == "B" and response.json()["next_offset"] is None
    current = "b" * 64
    assert client.get(read, params=params, headers=headers).status_code == 409
    assert (
        client.get(
            read, params={"source_id": "sources/../notes/secret.md"}, headers=headers
        ).status_code
        == 422
    )
    held.clear()
    before = len(calls)
    assert client.get(read, params=params, headers=headers).status_code == 403
    assert len(calls) == before


def test_agent_event_feed_replays_pages_and_publishes_late_commit_without_disclosing_hidden_task(
    client, iam_user, project_factory, delegated_token
):
    owner = iam_user("agent-event-owner", "admin")
    reader = iam_user("agent-event-reader", "rd")
    second_reader = iam_user("agent-event-reader2", "rd")
    project = project_factory(owner, (reader, second_reader), task_owner_id=owner)
    visible_task, hidden_task = f"{project}-t1", f"{project}-t2"
    now = datetime.now(UTC)
    with SessionLocal() as db:
        db.get(Task, visible_task).owner_id = reader
        db.add_all(
            [
                TaskActivity(
                    id=f"{project}-approval",
                    task_id=visible_task,
                    actor_id=owner,
                    kind="acceptance",
                    body="验收通过",
                    created_at=now,
                ),
                TaskActivity(
                    id=f"{project}-hidden",
                    task_id=hidden_task,
                    actor_id=owner,
                    kind="deliverable",
                    body="restricted",
                    created_at=now,
                ),
                TaskActivity(
                    id=f"{project}-progress",
                    task_id=visible_task,
                    actor_id=reader,
                    kind="progress",
                    created_at=now,
                    changes={
                        "progress": {"before": 0, "after": 50},
                        "actual_cost": {"before": 0, "after": 1000},
                    },
                ),
            ]
        )
        db.commit()

    headers = delegated_token(reader)
    feed = f"{ROOT}/projects/{project}/changes"
    first = client.get(feed, params={"limit": 1}, headers=headers)
    assert first.status_code == 200, first.text
    page = first.json()
    assert page["has_more"] and [item["kind"] for item in page["items"]] == ["approval"]
    cursor = page["next_cursor"]
    second = client.get(feed, params={"cursor": cursor}, headers=headers).json()
    assert len(second["items"]) == 1
    assert second["items"][0]["changes"] == {"progress": {"before": 0, "after": 50}}
    assert not second["has_more"]
    assert (
        client.get(feed, params={"cursor": cursor}, headers=headers).json()["items"]
        == second["items"]
    )
    assert (
        client.get(feed, params={"cursor": cursor, "kind": "delay"}, headers=headers).status_code
        == 422
    )
    assert (
        client.get(
            feed, params={"cursor": cursor}, headers=delegated_token(second_reader)
        ).status_code
        == 422
    )

    # This row's activity time precedes the checkpoint, but it became visible
    # to the polling transaction after that checkpoint was already delivered.
    with SessionLocal() as db:
        db.add(
            TaskActivity(
                id=f"{project}-delay",
                task_id=visible_task,
                actor_id=owner,
                kind="change",
                created_at=now - timedelta(minutes=10),
                changes={"planned_end": {"before": "2026-01-01", "after": "2026-01-02"}},
            )
        )
        db.commit()
    result = client.get(feed, params={"cursor": second["next_cursor"]}, headers=headers)
    assert result.status_code == 200, result.text
    assert [item["kind"] for item in result.json()["items"]] == ["delay"]
    assert (
        client.get(feed, params={"kind": "delay"}, headers=headers).json()["items"]
        == result.json()["items"]
    )
    expired = unseal(result.json()["next_cursor"])
    expired["expires_at"] = (now - timedelta(seconds=1)).isoformat()
    assert client.get(feed, params={"cursor": seal(expired)}, headers=headers).status_code == 410

    with SessionLocal() as db:
        db.get(Task, visible_task).owner_id = owner
        db.commit()
    assert client.get(feed, params={"cursor": cursor}, headers=headers).json()["items"] == []
