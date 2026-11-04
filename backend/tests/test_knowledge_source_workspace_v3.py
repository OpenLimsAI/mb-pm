# ruff: noqa: F811
"""Persistent personal state and exact filing against the real tenant store."""

import copy

import pytest
from fastapi import HTTPException
from test_information_live import store  # noqa: F401

from app.services import knowledge_source_workspace_v3 as service

ACTOR = {"subject": "alice"}


def test_collections_isolate_identities_and_reject_stale_revision(store):
    s, _ = store
    saved = service.save_collection(
        s,
        "alice",
        {
            "name": "质量待读",
            "query": {"scopes": ["Q"], "readingStates": ["unread"]},
            "revision": 0,
        },
    )
    assert saved["revision"] == 1
    assert service.public_workspace(s, "bob")["collections"] == []
    with pytest.raises(HTTPException) as stale:
        service.save_collection(s, "alice", {"name": "另一窗口", "query": {}, "revision": 0})
    assert stale.value.status_code == 409
    deleted = service.save_collection(
        s, "alice", {**saved["collections"][0], "deleted": True, "revision": 1}
    )
    assert deleted["collections"] == []


def test_dynamic_collection_reading_and_tags_are_current_not_saved_ids(store):
    s, _ = store
    s.put("document", {"id": "doc1", "scopes": ["Q"]})
    query = {"scopes": ["Q"], "readingStates": ["unread"], "tags": ["stable"]}
    paper = {
        "id": "a.md",
        "title": "Stability",
        "documentId": "doc1",
        "tags": [{"id": "stable", "name": "稳定性"}],
        "folderIds": [],
    }
    assert service.matched_papers(s, "alice", query, [paper]) == [paper]
    service.save_reading(
        s, "alice", {"paperId": paper["id"], "state": "done", "position": {"offset": 40}}, [paper]
    )
    assert service.matched_papers(s, "alice", query, [paper]) == []
    assert service.matched_papers(s, "bob", query, [paper]) == [paper]
    assert not service.matches(paper, {"sourceIds": ["other"]})


def test_reading_is_version_bound_and_location_preserves_collections(store):
    s, _ = store
    paper = {"id": "a", "title": "A", "versionId": "v1"}
    with pytest.raises(HTTPException) as hidden:
        service.save_reading(s, "alice", {"paperId": "a", "state": "reading"}, [])
    assert hidden.value.status_code == 404
    with pytest.raises(HTTPException) as changed:
        service.save_reading(
            s, "alice", {"paperId": "a", "state": "reading", "versionId": "v2"}, [paper]
        )
    assert changed.value.status_code == 409
    reading = service.save_reading(
        s,
        "alice",
        {"paperId": "a", "state": "reading", "versionId": "v1", "position": {"offset": 510}},
        [paper],
    )
    assert reading["position"] == {"offset": 510}
    saved = service.save_collection(s, "alice", {"name": "全部", "query": {}, "revision": 0})
    next_state = service.save_location(
        s, "alice", {"folderId": "f1", "scrollTop": 400, "paperId": "a"}
    )
    assert next_state["collections"] == saved["collections"]
    assert service.public_workspace(s, "bob")["reading"] == {}
    assert next_state["location"]["scrollTop"] == 400


def rules_fixture(s, count=2):
    state = {
        "folders": [{"id": "target"}],
        "revision": 0,
        "memberships": {f"p{i}.md": [] for i in range(count)},
    }

    def papers():
        return [
            {"id": key, "title": "Quality " + key, "folderIds": value, "createdAt": service.iso()}
            for key, value in state["memberships"].items()
        ]

    calls = []

    def connect(operation, subject, *, mutation):
        assert operation == "folderMutation" and subject == "alice"
        assert mutation["revision"] == state["revision"]
        calls.append(copy.deepcopy(mutation))
        for path in mutation["paths"]:
            state["memberships"][path] = sorted(
                set(state["memberships"][path]) | set(mutation["folderIds"])
            )
        state["revision"] += 1
        return {"revision": state["revision"]}

    saved = service.save_rule(
        s,
        "alice",
        {
            "name": "Quality",
            "query": {"text": "Quality"},
            "targetFolderIds": ["target"],
            "revision": 0,
        },
        state["folders"],
    )
    return state, papers, calls, connect, saved["rules"][0]


def test_rule_batches_501_papers_with_exact_revision_and_undo_receipts(store):
    s, _ = store
    state, papers, calls, connect, rule = rules_fixture(s, 501)
    preview = service.rule_preview(s, "alice", rule["id"], papers())
    assert preview["total"] == 501 and len(preview["papers"]) == 100
    result = service.apply_rule(
        s,
        ACTOR,
        rule["id"],
        catalogue=state,
        papers=papers(),
        connect=connect,
        preview_digest=preview["previewDigest"],
    )
    assert result["count"] == 501 and len(result["undoTokens"]) == 2
    assert [len(call["paths"]) for call in calls] == [500, 1]
    assert all(target == ["target"] for target in state["memberships"].values())
    assert len(s.records("ks_undo")) == 2


def test_rule_partial_failure_returns_successful_undo_without_faking_full_success(store):
    s, _ = store
    state, papers, calls, connect, rule = rules_fixture(s, 501)

    def fail_second(*args, **kwargs):
        if calls:
            raise HTTPException(409, "concurrent update")
        return connect(*args, **kwargs)

    result = service.apply_rule(
        s, ACTOR, rule["id"], catalogue=state, papers=papers(), connect=fail_second
    )
    assert not result["saved"] and result["partial"]
    assert result["count"] == 500 and len(result["undoTokens"]) == 1
    assert state["memberships"]["p500.md"] == []


def test_rules_require_real_condition_and_existing_targets(store):
    s, _ = store
    for query, targets in [
        ({}, ["f"]),
        ({"updatedOnly": False}, ["f"]),
        ({"text": "yes"}, ["gone"]),
    ]:
        with pytest.raises(HTTPException):
            service.save_rule(
                s, "alice", {"name": "x", "query": query, "targetFolderIds": targets}, [{"id": "f"}]
            )
    with pytest.raises(HTTPException):
        service.validate_query({"regex": ".*"})


def test_automatic_filing_defaults_off_and_only_just_saved_ids(store):
    s, _ = store
    state, papers, calls, connect, rule = rules_fixture(s)
    assert not rule["enabled"]
    assert (
        service.apply_enabled_rules(
            s, ACTOR, catalogue=state, papers=papers(), connect=connect, paper_ids=["p1.md"]
        )
        == []
    )
    service.save_rule(s, "alice", {**rule, "enabled": True, "revision": 1}, state["folders"])
    service.apply_enabled_rules(
        s, ACTOR, catalogue=state, papers=papers(), connect=connect, paper_ids=["p1.md"]
    )
    assert calls[0]["paths"] == ["p1.md"]
    assert state["memberships"]["p0.md"] == []


def test_duplicate_candidates_never_merge_revisions_or_mutate_originals():
    papers = [
        {
            "id": "p1",
            "title": "Quality risk management",
            "metadata": {"doi": "https://doi.org/10.1234/TEST"},
            "documentId": "d",
            "versionId": "v1",
        },
        {
            "id": "p2",
            "title": "Quality risk management",
            "metadata": {"doi": "10.1234/test"},
            "documentId": "d",
            "versionId": "v2",
        },
    ]
    result = service.duplicate_candidates(papers)
    assert result["total"] == 1
    assert result["groups"][0]["sameDocumentVersions"]
    assert result["groups"][0]["automaticMerge"] is False
    assert papers[0]["versionId"] == "v1"


def test_reading_api_authorizes_only_selected_paper_and_does_not_scan_library(store, monkeypatch):
    from app.api.v1 import knowledge_source_workspace_v3 as api

    s, db = store
    calls = []

    def connect(operation, subject, **values):
        calls.append((operation, subject, values))
        return {"path": values["path"], "hash": "h", "body": "x"}

    monkeypatch.setattr(api, "connected", connect)
    result = api.reading(
        api.ReadingInput(paperId="sources/one.md", state="reading", position={"offset": 14}),
        db=db,
        actor={**ACTOR, "tenant": s.tenant},
    )
    assert result["position"]["offset"] == 14
    assert calls == [("readPaper", "alice", {"path": "sources/one.md", "offset": 0, "limit": 1})]


def test_reading_api_cannot_use_archived_alias_to_bypass_deleted_core_paper(store, monkeypatch):
    from app.api.v1 import knowledge_source_workspace_v3 as api

    s, db = store
    s.put("document", {"id": "doc"})
    s.put("version", {"id": "v1", "documentId": "doc", "kbPath": "deleted.md"})
    db.commit()

    def denied(*args, **kwargs):
        raise HTTPException(404, "Core deleted")

    monkeypatch.setattr(api, "connected", denied)
    with pytest.raises(HTTPException) as result:
        api.reading(
            api.ReadingInput(paperId="archive:v1", versionId="v1", state="done"),
            db=db,
            actor={**ACTOR, "tenant": s.tenant},
        )
    assert result.value.status_code == 404
    assert service.public_workspace(s, "alice")["reading"] == {}


def test_reading_alias_survives_ingest_but_new_version_is_unread():
    entries = {"archive:v1": {"state": "done", "position": {"offset": 100}, "versionId": "v1"}}
    paper = {"id": "ingested.md", "versionId": "v1"}
    assert service.reading_for(paper, entries)["state"] == "done"
    entries["ingested.md"] = entries["archive:v1"]
    assert service.reading_for({**paper, "versionId": "v2"}, entries)["state"] == "unread"
    assert service.matches({**paper, "versionId": "v2"}, {"readingStates": ["unread"]}, entries)


def test_reading_pending_upload_requires_matching_server_receipt(store, monkeypatch):
    from app.api.v1 import knowledge_source_workspace_v3 as api

    s, db = store
    s.put("document", {"id": "logical"})
    s.put(
        "version",
        {
            "id": "v-pending",
            "documentId": "logical",
            "kbDocumentId": "core-id",
            "kbPath": "pending.md",
            "sha256": "sha-proof",
            "kbPending": True,
            "indexStatus": "pending",
        },
    )
    db.commit()
    proofs = [
        {
            "documentId": "core-id",
            "sha256": "sha-proof",
            "path": "pending.md",
            "indexStatus": "pending",
        }
    ]

    def catalogue(actor, *, imports):
        assert imports == [{"documentId": "core-id", "sha256": "sha-proof"}]
        return {"papers": [], "pendingArchives": proofs}

    monkeypatch.setattr(api, "library", catalogue)

    def unreadable(*args, **kwargs):
        raise AssertionError("Unregistered pending body must not be read as Core")

    monkeypatch.setattr(api, "connected", unreadable)
    payload = api.ReadingInput(
        paperId="archive:v-pending", state="reading", position={"offset": 25}
    )
    result = api.reading(payload, db=db, actor={**ACTOR, "tenant": s.tenant})
    assert result["position"]["offset"] == 25
    proofs[0] = {**proofs[0], "documentId": "wrong-core-document"}
    with pytest.raises(HTTPException) as denied:
        api.reading(payload, db=db, actor={**ACTOR, "tenant": s.tenant})
    assert denied.value.status_code == 404


def test_reading_uses_pm_canonical_version_and_accepts_core_only_papers(store, monkeypatch):
    from app.api.v1 import knowledge_source_workspace_v3 as api

    s, db = store
    s.put(
        "version",
        {
            "id": "pm-version",
            "documentId": "logical",
            "kbPath": "linked.md",
            "createdAt": "2026-11-04T00:00:00Z",
        },
    )
    db.commit()
    monkeypatch.setattr(
        api,
        "connected",
        lambda *args, **kwargs: {"versionId": "core-version", "hash": "h", "body": "x"},
    )
    actor = {**ACTOR, "tenant": s.tenant}
    linked = api.reading(
        api.ReadingInput(paperId="linked.md", versionId="pm-version", state="reading"),
        db=db,
        actor=actor,
    )
    assert linked["versionId"] == "pm-version"
    core_input = api.reading(
        api.ReadingInput(paperId="linked.md", versionId="core-version", state="reading"),
        db=db,
        actor=actor,
    )
    assert core_input["versionId"] == "pm-version"
    core_only = api.reading(
        api.ReadingInput(paperId="core-only.md", versionId="core-version", state="done"),
        db=db,
        actor=actor,
    )
    assert core_only["versionId"] == "core-version"
    with pytest.raises(HTTPException) as stale:
        api.reading(
            api.ReadingInput(paperId="core-only.md", versionId="foreign-version", state="done"),
            db=db,
            actor=actor,
        )
    assert stale.value.status_code == 409


def test_late_automatic_progress_cannot_overwrite_explicit_done_state(store):
    s, _ = store
    paper = {"id": "paper.md", "versionId": "v1"}
    first = service.save_reading(
        s,
        "alice",
        {"paperId": paper["id"], "versionId": "v1", "state": "reading", "position": {"offset": 20}},
        [paper],
    )
    done = service.save_reading(
        s,
        "alice",
        {"paperId": paper["id"], "versionId": "v1", "state": "done", "position": {"offset": 500}},
        [paper],
    )
    with pytest.raises(HTTPException) as stale:
        service.save_reading(
            s,
            "alice",
            {
                "paperId": paper["id"],
                "versionId": "v1",
                "state": "reading",
                "position": {"offset": 30},
                "automatic": True,
                "expectedUpdatedAt": first["updatedAt"],
            },
            [paper],
        )
    assert stale.value.status_code == 409
    current = service.public_workspace(s, "alice")["reading"][paper["id"]]
    assert current["state"] == "done" and current["position"] == {"offset": 500}
    assert current["updatedAt"] == done["updatedAt"]


def test_new_version_can_start_automatic_reading_without_erasing_old_version(store):
    s, _ = store
    old = {"id": "paper.md", "versionId": "v1"}
    service.save_reading(
        s,
        "alice",
        {"paperId": "paper.md", "versionId": "v1", "state": "done", "position": {"page": 3}},
        [old],
    )
    new = {**old, "versionId": "v2"}
    saved = service.save_reading(
        s,
        "alice",
        {
            "paperId": "paper.md",
            "versionId": "v2",
            "state": "reading",
            "position": {"page": 1},
            "automatic": True,
            "expectedUpdatedAt": None,
        },
        [new],
    )
    entries = service.public_workspace(s, "alice")["reading"]
    assert saved["state"] == "reading" and saved["versionId"] == "v2"
    assert entries["archive:v1"]["state"] == "done"
    assert entries["paper.md"]["versionId"] == "v2"


def test_ingest_alias_and_core_path_use_one_cas_reading_row(store):
    s, _ = store
    archived = {"id": "archive:v1", "versionId": "v1"}
    original = service.save_reading(
        s,
        "alice",
        {"paperId": "archive:v1", "versionId": "v1", "state": "reading", "position": {"page": 2}},
        [archived],
    )
    core = {"id": "core.md", "versionId": "v1"}
    migrated = service.save_reading(
        s,
        "alice",
        {
            "paperId": "core.md",
            "versionId": "v1",
            "state": "reading",
            "position": {"page": 3},
            "automatic": True,
            "expectedUpdatedAt": original["updatedAt"],
        },
        [core],
    )
    assert migrated["position"]["page"] == 3
    assert len(s.records("ks_reading")) == 1
    entries = service.public_workspace(s, "alice")["reading"]
    assert entries["archive:v1"]["updatedAt"] == entries["core.md"]["updatedAt"]


def test_explicit_first_insert_retries_conflict_but_automatic_never_overwrites(store, monkeypatch):
    from sqlalchemy.exc import IntegrityError

    s, _ = store
    original = s.put
    count = 0

    def collision_once(kind, value):
        nonlocal count
        if kind == "ks_reading":
            count += 1
            if count == 1:
                raise IntegrityError("concurrent first insert", {}, Exception("duplicate"))
        return original(kind, value)

    monkeypatch.setattr(s, "put", collision_once)
    paper = {"id": "paper.md", "versionId": "v1"}
    saved = service.save_reading(
        s, "alice", {"paperId": "paper.md", "versionId": "v1", "state": "done"}, [paper]
    )
    assert saved["state"] == "done" and count == 2


def test_reading_current_version_alias_wins_over_later_history_visit():
    entries = {
        "paper.md": {"state": "done", "versionId": "v1"},
        "archive:v1": {"state": "done", "versionId": "v1"},
        "archive:v2": {"state": "reading", "versionId": "v2", "position": {"page": 4}},
    }
    assert service.reading_for({"id": "paper.md", "versionId": "v2"}, entries)["position"] == {
        "page": 4
    }
