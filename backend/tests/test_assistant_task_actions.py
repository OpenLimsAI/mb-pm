"""Task ownership permits soft-delete metadata without revealing protected history."""

import json
from uuid import uuid4

import pytest
import test_assistant
import test_assistant_projects
import test_solutions
from sqlalchemy import delete, event, select

from app.models import ProjectMember
from app.models.assistant import AssistantMessage, AssistantTask
from app.services import assistant as service

solution_client = test_solutions.solution_client
assistant_client = test_assistant.assistant_client
pm = test_assistant_projects.pm
PREFIX = test_assistant.PREFIX
CONTENT = "PROTECTED-CONTENT-MUST-NOT-APPEAR"
CONTEXT = "PROTECTED-CONTEXT-MUST-NOT-APPEAR"


def message_rows(f, task_id):
    return [
        dict(row)
        for row in f.db.execute(
            select(AssistantMessage.__table__)
            .where(AssistantMessage.task_id == task_id)
            .order_by(AssistantMessage.position)
        ).mappings()
    ]


@pytest.fixture(params=["legacy", "revoked"])
def protected_task(pm, request):
    f = pm
    task = test_assistant.create(f, title="不可读但可管理的任务")
    if request.param == "legacy":
        request_id = str(uuid4())
        for position, role in enumerate(("user", "assistant")):
            f.db.add(
                AssistantMessage(
                    id=str(uuid4()),
                    task_id=task["id"],
                    request_id=request_id,
                    position=position,
                    role=role,
                    content=CONTENT,
                    context=CONTEXT,
                    data_sources='["projects"]',
                    application_scope={},
                )
            )
        f.db.commit()
    else:
        test_assistant_projects.project(f)
        response = test_assistant_projects.ask(f, task)
        assert response.status_code == 200, response.text
        task = response.json()
        for row in f.db.scalars(
            select(AssistantMessage).where(AssistantMessage.task_id == task["id"])
        ):
            row.content, row.context = CONTENT, CONTEXT
        f.db.execute(delete(ProjectMember).where(ProjectMember.user_id == "pm-author"))
        f.db.commit()
    assert f.client.get(f"{PREFIX}/{task['id']}").status_code == 403
    return f, task


def test_owner_can_trash_and_restore_without_reading_protected_messages(
    protected_task, monkeypatch
):
    f, task = protected_task
    path = f"{PREFIX}/{task['id']}"
    original = message_rows(f, task["id"])
    count_queries = []

    def metadata_only(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().lower().startswith("select") and "assistant_messages" in statement:
            assert "count(" in statement.lower(), "mutation fetched protected message rows"
            count_queries.append(statement)

    def forbidden(*_args, **_kwargs):
        pytest.fail("metadata mutation tried to authorize/read protected history")

    with monkeypatch.context() as mutation:
        mutation.setattr(service, "check_history_access", forbidden)
        mutation.setattr(service, "detail", forbidden)
        event.listen(f.db.bind, "before_cursor_execute", metadata_only)
        try:
            removed = f.client.post(path + "/trash", json={"revision": task["revision"]})
            assert removed.status_code == 200, removed.text
            deleted = removed.json()
            assert deleted["deleted_at"] and deleted["revision"] == task["revision"] + 1
            restored = f.client.post(path + "/restore", json={"revision": deleted["revision"]})
            assert restored.status_code == 200, restored.text
        finally:
            event.remove(f.db.bind, "before_cursor_execute", metadata_only)
    for response in (removed, restored):
        payload = response.json()
        assert set(payload) == {
            "id",
            "title",
            "instructions",
            "revision",
            "created_at",
            "updated_at",
            "deleted_at",
            "message_count",
            "memory",
            "pinned",
            "final_artifact_id",
        }
        assert payload["message_count"] == len(original)
        assert CONTENT not in response.text and CONTEXT not in response.text
    assert len(count_queries) == 2
    assert restored.json()["deleted_at"] is None
    assert restored.json()["revision"] == task["revision"] + 2
    assert message_rows(f, task["id"]) == original
    # Management of the task never grants permission to its old evidence.
    detail = f.client.get(path)
    assert detail.status_code == 403 and CONTENT not in detail.text
    saved = f.client.put(path, json={"revision": restored.json()["revision"], "title": "拒绝更名"})
    assert saved.status_code == 403
    question = test_assistant.question(f, restored.json(), answer_mode="general")
    assert question.status_code == 403
    assert message_rows(f, task["id"]) == original


def test_protected_task_mutations_reject_other_owner_and_issuer(protected_task):
    f, task = protected_task
    path = f"{PREFIX}/{task['id']}"
    f.login("other")
    for action in ("trash", "restore"):
        response = f.client.post(path + "/" + action, json={"revision": task["revision"]})
        assert response.status_code == 404 and CONTENT not in response.text
    f.login()
    stored = f.db.get(AssistantTask, task["id"])
    stored.issuer = "https://other-issuer.example"
    f.db.commit()
    for action in ("trash", "restore"):
        assert (
            f.client.post(path + "/" + action, json={"revision": task["revision"]}).status_code
            == 404
        )
    f.db.expire_all()
    stored = f.db.get(AssistantTask, task["id"])
    assert stored.revision == task["revision"] and stored.deleted_at is None


@pytest.mark.parametrize("origin", [None, "https://other.example"])
def test_protected_task_mutations_still_require_trusted_origin(protected_task, origin):
    f, task = protected_task
    path = f"{PREFIX}/{task['id']}"
    f.client.headers.pop("Origin")
    headers = {"Origin": origin} if origin else {}
    for action in ("trash", "restore"):
        response = f.client.post(
            path + "/" + action, json={"revision": task["revision"]}, headers=headers
        )
        assert response.status_code == 403 and CONTENT not in response.text
    f.db.expire_all()
    stored = f.db.get(AssistantTask, task["id"])
    assert stored.revision == task["revision"] and stored.deleted_at is None


def test_protected_task_revisions_and_soft_delete_state_are_atomic(protected_task):
    f, task = protected_task
    path = f"{PREFIX}/{task['id']}"
    original = message_rows(f, task["id"])
    stale = f.client.post(path + "/trash", json={"revision": task["revision"] + 1})
    assert stale.status_code == 409
    removed = f.client.post(path + "/trash", json={"revision": task["revision"]})
    assert removed.status_code == 200
    deleted = removed.json()
    assert f.client.post(path + "/trash", json={"revision": deleted["revision"]}).status_code == 409
    assert f.client.post(path + "/restore", json={"revision": task["revision"]}).status_code == 409
    restored = f.client.post(path + "/restore", json={"revision": deleted["revision"]})
    assert restored.status_code == 200
    assert (
        f.client.post(path + "/restore", json={"revision": restored.json()["revision"]}).status_code
        == 409
    )
    assert message_rows(f, task["id"]) == original
    assert CONTENT not in json.dumps([deleted, restored.json()])
