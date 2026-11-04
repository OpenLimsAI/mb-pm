# ruff: noqa: F811
"""Committed downloads survive optional rule failures; real store and folder mutations."""

import copy

from fastapi import HTTPException
from test_information_live import store  # noqa: F401

from app.services import knowledge_source_worker as worker
from app.services import knowledge_source_workspace_v3 as workspace
from app.services.information.store import iso


def setup(s, *, enabled=True, count=1):
    folders = [{"id": "default"}, {"id": "target"}, {"id": "other"}]
    if enabled:
        workspace.save_rule(
            s,
            "alice",
            {
                "name": "Quality",
                "query": {"tags": ["quality"]},
                "targetFolderIds": ["target"],
                "enabled": True,
                "revision": 0,
            },
            folders,
        )
    source = s.ensure_source()
    docid = s.key("document", "doc")
    s.put(
        "document",
        {
            "id": docid,
            "title": "Quality source",
            "sourceId": source["id"],
            "scopes": ["Q"],
            "url": "https://database.ich.org/quality.pdf",
            "folderIds": ["default"],
        },
    )
    version = s.archive(
        docid, b"%PDF-real-retained-file", "Retained native text", parse_status="ready"
    )
    path = f"sources/{count - 1}.md"
    version.update(kbPath=path, indexStatus="ready")
    s.put("version", version)
    job = {
        "id": s.key("job", "import"),
        "app": "knowledge-sources",
        "sourceId": source["id"],
        "actorSubject": "alice",
        "kind": "import",
        "status": "completed",
        "filingV3StartedAt": iso(),
        "items": [{"documentId": docid, "versionId": version["id"], "status": "saved"}],
    }
    s.put("job", job)
    s.db.commit()
    state = {
        "canWrite": True,
        "revision": 0,
        "folders": folders,
        "papers": [
            {"path": f"sources/{i}.md", "title": "Quality paper", "indexStatus": "ready"}
            for i in range(count)
        ],
        "memberships": {f"sources/{i}.md": ["default"] for i in range(count)},
    }
    calls = []

    def connector(operation, subject, **values):
        assert subject == "alice"
        calls.append((operation, copy.deepcopy(values)))
        if operation == "library":
            return copy.deepcopy(state)
        if operation == "queryLibrary":
            offset, limit = values["offset"], values["limit"]
            papers = state["papers"][offset : offset + limit]
            return {
                "papers": [
                    {**paper, "tags": ["quality"] if paper["path"] == path else []}
                    for paper in papers
                ],
                "nextOffset": offset + limit if offset + limit < count else None,
            }
        assert operation == "folderMutation"
        mutation = values["mutation"]
        assert mutation["revision"] == state["revision"]
        for target in mutation["paths"]:
            state["memberships"][target] = sorted(
                set(state["memberships"][target]) | set(mutation["folderIds"])
            )
        state["revision"] += 1
        return {"revision": state["revision"]}

    return job, version, state, calls, connector


def test_completed_download_is_filed_once_with_owner_rules_and_full_metadata_pages(
    store, monkeypatch
):
    s, _ = store
    job, version, state, calls, connector = setup(s, count=201)
    checked = []
    monkeypatch.setattr(worker, "authority", lambda db, subject: checked.append(subject))
    workspace.save_rule(
        s,
        "bob",
        {
            "name": "Other person",
            "query": {"text": "Quality"},
            "targetFolderIds": ["other"],
            "enabled": True,
            "revision": 0,
        },
        state["folders"],
    )
    worker.automatic_filing(s, job, connector)
    saved = s.get("job", job["id"])
    assert saved["status"] == "completed" and saved["filingV3Done"]
    assert saved["ruleFiling"]["ruleApplications"] == 1
    assert len(saved["ruleFiling"]["undoTokens"]) == 1
    assert [values["offset"] for operation, values in calls if operation == "queryLibrary"] == [
        0,
        100,
        200,
    ]
    assert state["memberships"]["sources/200.md"] == ["default", "target"]
    assert checked == ["alice"]
    assert s.archive_path(version).read_bytes() == b"%PDF-real-retained-file"
    count = len(calls)
    worker.automatic_filing(s, job, connector)  # Even a stale caller copy is idempotent.
    assert len(calls) == count


def test_archive_is_preserved_when_write_permission_is_lost(store, monkeypatch):
    s, _ = store
    job, version, state, calls, connector = setup(s)
    monkeypatch.setattr(worker, "authority", lambda *_: None)
    state["canWrite"] = False
    worker.automatic_filing(s, job, connector)
    saved = s.get("job", job["id"])
    assert saved["status"] == "completed" and saved["ruleFiling"]["status"] == "failed"
    assert not any(operation == "folderMutation" for operation, _ in calls)
    assert s.archive_path(version).read_bytes() == b"%PDF-real-retained-file"


def test_inactive_actor_and_disabled_rules_cannot_trigger_filing(store, monkeypatch):
    s, _ = store
    job, _, _, calls, connector = setup(s, enabled=False)
    worker.automatic_filing(s, job, connector)
    assert s.get("job", job["id"])["ruleFiling"]["status"] == "skipped" and not calls
    s.put("job", {**job, "filingV3Done": False})
    workspace.save_rule(
        s,
        "alice",
        {
            "name": "Rule",
            "query": {"text": "Quality"},
            "targetFolderIds": ["target"],
            "enabled": True,
            "revision": 0,
        },
        [{"id": "target"}],
    )

    def forbidden(*args):
        raise HTTPException(403, "IAM actor revoked")

    monkeypatch.setattr(worker, "authority", forbidden)
    worker.automatic_filing(s, job, connector)
    assert s.get("job", job["id"])["ruleFiling"]["status"] == "failed" and not calls


def test_historical_completed_jobs_never_receive_new_rules_on_release(store, monkeypatch):
    s, _ = store
    job, _, _, calls, connector = setup(s)
    job.pop("filingV3StartedAt")
    s.put("job", job)
    s.db.commit()
    worker.automatic_filing(s, job, connector)
    assert not calls and not s.get("job", job["id"]).get("filingV3Done")


def test_rule_enable_does_not_retroactively_file_reused_old_original(store, monkeypatch):
    s, _ = store
    job, version, state, calls, connector = setup(s)
    version["createdAt"] = "2001-01-01T00:00:00+00:00"
    s.put("version", version)
    s.db.commit()
    monkeypatch.setattr(worker, "authority", lambda *_: None)
    worker.automatic_filing(s, job, connector)
    assert state["memberships"]["sources/0.md"] == ["default"]
    assert not any(operation == "folderMutation" for operation, _ in calls)
    assert s.get("job", job["id"])["ruleFiling"]["ruleApplications"] == 0


def test_later_rule_failure_keeps_first_rule_undo_receipts_and_original(store, monkeypatch):
    s, _ = store
    job, version, state, calls, connector = setup(s)
    monkeypatch.setattr(worker, "authority", lambda *_: None)
    workspace.save_rule(
        s,
        "alice",
        {
            "name": "Missing destination",
            "query": {"text": "Quality"},
            "targetFolderIds": ["other"],
            "enabled": True,
            "revision": 1,
        },
        state["folders"],
    )
    # This original was downloaded after both explicit opt-ins.
    version["createdAt"] = iso()
    s.put("version", version)
    s.db.commit()
    state["folders"] = [folder for folder in state["folders"] if folder["id"] != "other"]
    worker.automatic_filing(s, job, connector)
    saved = s.get("job", job["id"])
    assert saved["status"] == "completed" and saved["ruleFiling"]["status"] == "partial"
    assert len(saved["ruleFiling"]["undoTokens"]) == 1
    assert state["memberships"]["sources/0.md"] == ["default", "target"]
    assert s.archive_path(version).read_bytes() == b"%PDF-real-retained-file"
