# ruff: noqa: F811
"""Classification contract tests with real PM store and bounded KB mutation stand-in."""

import copy

import pytest
from fastapi import HTTPException
from test_information_live import store  # noqa: F401

from app.services.knowledge_source_folders import folder_action, organize_papers, undo_organization

F1, F2 = "first", "second"
P1 = "sources/paper.md"
ACTOR = {"subject": "person"}


def setup(store):
    state = {"revision": 0, "folders": [{"id": F1}, {"id": F2}], "memberships": {P1: [F1]}}

    def connect(operation, subject, *, mutation):
        assert operation == "folderMutation" and subject == "person"
        assert mutation["revision"] == state["revision"]
        action = mutation["operation"]
        if action in ("delete", "merge"):
            state["folders"] = [
                folder for folder in state["folders"] if folder["id"] != mutation["folderId"]
            ]
        elif action == "metadata":
            next(
                folder for folder in state["folders"] if folder["id"] == mutation["folderId"]
            ).update({key: mutation[key] for key in ("kind", "parentId") if key in mutation})
        else:
            for path in mutation["paths"]:
                current = set(state["memberships"][path])
                if action == "restore":
                    current = set(mutation["memberships"][path])
                elif action == "remove":
                    current -= set(mutation["folderIds"])
                else:
                    if action == "move":
                        current.discard(mutation["fromFolderId"])
                    current |= set(mutation["folderIds"])
                state["memberships"][path] = sorted(current)
        state["revision"] += 1
        return copy.deepcopy(state)

    def papers():
        return [{"id": P1, "folderIds": state["memberships"][P1]}]

    return state, connect, papers


def test_organize_and_undo_restore_exact_memberships_and_reject_reuse(store):
    store, _ = store
    state, connect, papers = setup(store)
    saved = organize_papers(
        store,
        ACTOR,
        {"paperIds": [P1], "folderIds": [F2], "mode": "add", "revision": 0},
        catalogue=state,
        connect=connect,
        papers=papers(),
    )
    assert state["memberships"][P1] == [F1, F2]
    undo = {"token": saved["undoToken"], "revision": state["revision"]}
    result = undo_organization(
        store, ACTOR, undo, catalogue=state, connect=connect, papers=papers()
    )
    assert result["revision"] == 2
    assert state["memberships"][P1] == [F1]
    undo["revision"] = state["revision"]
    with pytest.raises(HTTPException, match="已撤销"):
        undo_organization(store, ACTOR, undo, catalogue=state, connect=connect, papers=papers())


def test_undo_does_not_overwrite_later_changes_or_revive_deleted_papers(store):
    store, _ = store
    state, connect, papers = setup(store)
    saved = organize_papers(
        store,
        ACTOR,
        {"paperIds": [P1], "folderIds": [F2], "mode": "move", "fromFolderId": F1, "revision": 0},
        catalogue=state,
        connect=connect,
        papers=papers(),
    )
    request = {"token": saved["undoToken"], "revision": state["revision"]}
    with pytest.raises(HTTPException, match="不可访问"):
        undo_organization(store, ACTOR, request, catalogue=state, connect=connect, papers=[])
    state["memberships"][P1] = []
    with pytest.raises(HTTPException, match="后续修改"):
        undo_organization(store, ACTOR, request, catalogue=state, connect=connect, papers=papers())
    with pytest.raises(HTTPException) as denied:
        undo_organization(
            store, {"subject": "other"}, request, catalogue=state, connect=connect, papers=papers()
        )
    assert denied.value.status_code == 404


def test_batch_limit_and_archive_only_undo_preserve_original(store):
    store, _ = store
    state, connect, _ = setup(store)
    with pytest.raises(HTTPException, match="500"):
        organize_papers(
            store,
            ACTOR,
            {
                "paperIds": [str(n) for n in range(501)],
                "folderIds": [F2],
                "mode": "add",
                "revision": 0,
            },
            catalogue=state,
            connect=connect,
            papers=[],
        )
    store.put("document", {"id": "doc", "folderIds": [F1]})
    paper = {"id": "archive:version", "documentId": "doc", "folderIds": [F1]}
    saved = organize_papers(
        store,
        ACTOR,
        {"paperIds": [paper["id"]], "folderIds": [F2], "mode": "add", "revision": 0},
        catalogue=state,
        connect=connect,
        papers=[paper],
    )
    paper["folderIds"] = [F1, F2]
    undo_organization(
        store,
        ACTOR,
        {"token": saved["undoToken"], "revision": 0},
        catalogue=state,
        connect=connect,
        papers=[paper],
    )
    assert store.get("ks_classification", store.key("ks_classification", "doc"))["folderIds"] == [
        F1
    ]
    assert store.get("document", "doc")["folderIds"] == [F1]


def test_folder_delete_blocks_active_download_and_merge_updates_pending_classifications(store):
    store, _ = store
    state, connect, _ = setup(store)
    store.put("job", {"id": "active", "folderId": F1, "status": "paused"})
    with pytest.raises(HTTPException, match="未完成"):
        folder_action(
            store, ACTOR, F1, {"action": "delete", "revision": 0}, catalogue=state, connect=connect
        )
    store.put("job", {"id": "active", "folderId": F1, "status": "completed"})
    store.put("source", {"id": "src", "folderId": F1, "archiveFolderId": F1})
    store.put("document", {"id": "doc", "folderIds": [F1]})
    folder_action(
        store,
        ACTOR,
        F1,
        {"action": "merge", "revision": 0, "targetFolderId": F2},
        catalogue=state,
        connect=connect,
    )
    assert store.get("source", "src")["folderId"] == F2
    assert store.get("document", "doc")["folderIds"] == [F2]
    assert store.get("job", "active")["status"] == "completed"


def test_source_destination_must_be_reassigned_before_folder_deletion(store):
    store, _ = store
    state, connect, _ = setup(store)
    store.put("source", {"id": "src", "folderId": F1})
    with pytest.raises(HTTPException, match="默认接收目录"):
        folder_action(
            store, ACTOR, F1, {"action": "delete", "revision": 0}, catalogue=state, connect=connect
        )
    assert state["revision"] == 0
