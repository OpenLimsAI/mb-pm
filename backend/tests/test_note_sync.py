"""Outbox durability, opt-in boundaries and newest-revision convergence."""

import pytest
import test_notes
from sqlalchemy import select
from test_notes import PREFIX, create, save_body

from app.models.note import NoteWisdomSync
from app.services import note_sync

solution_client = test_notes.solution_client
note_client = test_notes.note_client


class Core:
    def __init__(self):
        self.operations = []
        self.pages = {}
        self.fail_submit = False
        self.finish = True

    def submit(self, op):
        self.operations.append(dict(op))
        if self.fail_submit:
            self.fail_submit = False
            raise TimeoutError("response lost after remote acceptance")
        return str(len(self.operations))

    def find(self, op):
        return next(
            (
                str(i + 1)
                for i, item in enumerate(self.operations)
                if item["digest"] == op["digest"]
            ),
            None,
        )

    def poll(self, op):
        if not self.finish:
            return False
        if op["action"] == "publish":
            self.pages[op["path"]] = op["payload"]["body"]
        else:
            self.pages.pop(op["path"], None)
        return True


@pytest.fixture
def sharing(note_client, monkeypatch):
    monkeypatch.setattr(note_sync, "configured", lambda: True)
    monkeypatch.setattr(note_sync.accounts, "live_roles", lambda subject: {"kb_editor"})
    return note_client


def drain(f, core, count=12):
    for _ in range(count):
        row = f.db.scalar(select(NoteWisdomSync))
        if row:
            row.next_attempt_at = 0
            f.db.commit()
        note_sync.run_step(f.db, core)
        f.db.expire_all()


def share(f, note):
    r = f.client.post(
        f"{PREFIX}/{note['id']}/wisdom", json={"revision": note["revision"], "enabled": True}
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_new_private_notes_never_create_wisdom_job(sharing):
    f = sharing
    note = create(f, source_app="knowledge")
    f.client.put(f"{PREFIX}/{note['id']}", json=save_body(note, content="Private update"))
    assert f.db.scalar(select(NoteWisdomSync)) is None


def test_both_app_edits_delete_restore_converge(sharing):
    f = sharing
    core = Core()
    note = share(f, create(f, source_app="knowledge"))
    drain(f, core)
    assert list(core.pages.values()) == [note["content"]]
    note = f.client.put(
        f"{PREFIX}/{note['id']}", json=save_body(note, content="Updated from standalone")
    ).json()
    drain(f, core)
    assert list(core.pages.values()) == ["Updated from standalone"]
    note = f.client.post(f"{PREFIX}/{note['id']}/trash", json={"revision": note["revision"]}).json()
    drain(f, core)
    assert core.pages == {}
    note = f.client.post(
        f"{PREFIX}/{note['id']}/restore", json={"revision": note["revision"]}
    ).json()
    drain(f, core)
    assert list(core.pages.values()) == ["Updated from standalone"]


def test_lost_response_and_delete_while_publish_running(sharing):
    f = sharing
    core = Core()
    core.fail_submit = True
    note = share(f, create(f))
    drain(f, core, 1)
    assert f.db.scalar(select(NoteWisdomSync)).operation
    # A reconstructed service resumes the durable intent without re-POSTing.
    f.db.expire_all()
    f.client.post(f"{PREFIX}/{note['id']}/trash", json={"revision": note["revision"]})
    drain(f, core)
    assert [op["action"] for op in core.operations] == ["publish", "delete"]
    assert not core.pages


def test_rapid_edits_coalesce_and_private_revoke_does_not_need_editor_role(sharing, monkeypatch):
    f = sharing
    core = Core()
    note = share(f, create(f))
    for content in ["one", "two", "three"]:
        note = f.client.put(f"{PREFIX}/{note['id']}", json=save_body(note, content=content)).json()
    drain(f, core)
    assert len(core.operations) == 1 and list(core.pages.values()) == ["three"]
    monkeypatch.setattr(note_sync.accounts, "live_roles", lambda subject: set())
    revoked = f.client.post(
        f"{PREFIX}/{note['id']}/wisdom", json={"revision": note["revision"], "enabled": False}
    )
    assert revoked.status_code == 200
    drain(f, core)
    assert not core.pages
    assert (
        f.client.post(
            f"{PREFIX}/{note['id']}/wisdom",
            json={"revision": revoked.json()["revision"], "enabled": True},
        ).status_code
        == 403
    )


def test_other_account_cannot_share_and_stale_request_rolls_back(sharing):
    f = sharing
    note = create(f)
    f.login("other")
    assert (
        f.client.post(
            f"{PREFIX}/{note['id']}/wisdom", json={"revision": 1, "enabled": True}
        ).status_code
        == 404
    )
    f.login()
    note = share(f, note)
    assert (
        f.client.post(
            f"{PREFIX}/{note['id']}/wisdom", json={"revision": 1, "enabled": False}
        ).status_code
        == 409
    )
    f.db.expire_all()
    assert f.db.scalar(select(NoteWisdomSync)).enabled


def test_failed_publish_cleans_partial_index_before_retry(sharing):
    f = sharing
    core = Core()
    note = share(f, create(f))
    drain(f, core, 1)
    row = f.db.scalar(select(NoteWisdomSync))
    import json

    op = json.loads(row.operation)
    core.pages[op["path"]] = "partial"
    core.exists = lambda path: path in core.pages
    normal = core.poll
    core.poll = lambda op: (_ for _ in ()).throw(note_sync.TaskFailedError())
    drain(f, core, 1)
    assert f.db.scalar(select(NoteWisdomSync)).published_path == op["path"]
    core.poll = normal
    drain(f, core)
    assert list(core.pages.values()) == [note["content"]]
    assert [op["action"] for op in core.operations] == ["publish", "delete", "publish"]


def test_unknown_submission_does_not_blindly_repost(sharing):
    f = sharing
    core = Core()
    share(f, create(f))
    core.submit = lambda op: (_ for _ in ()).throw(TimeoutError())
    drain(f, core, 3)
    row = f.db.scalar(select(NoteWisdomSync))
    assert row.operation and row.status == "error" and not core.operations


def test_core_adapter_polls_status_before_result_and_traverses_pages(monkeypatch):
    core = note_sync.Core()
    calls = []
    operation = {
        "op": "wisdom.write",
        "task_id": "task-1",
        "digest": "wanted",
        "path": "wisdom/a.md",
        "action": "publish",
    }

    def request(method, path, **kwargs):
        calls.append(path)
        if path == "/v1/tasks/task-1":
            return {"task_id": "task-1", "op": "wisdom.write", "status": "running"}
        params = kwargs["params"]
        return (
            {"tasks": [{"task_id": "task-1", "params_digest": "wanted"}], "has_more": False}
            if params.get("cursor")
            else {"tasks": [], "has_more": True, "next_cursor": "next"}
        )

    monkeypatch.setattr(core, "request", request)
    assert not core.poll(operation)
    assert calls == ["/v1/tasks/task-1"]
    assert core.find(operation) == "task-1"
