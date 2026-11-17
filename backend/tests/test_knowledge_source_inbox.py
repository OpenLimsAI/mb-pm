# ruff: noqa: F401, F811
"""Real inbox routing and classification, including unregistered retained originals."""

import copy

import pytest
from test_information_api import live
from test_information_live import catalogue, store
from test_information_portal import information_portal
from test_knowledge_source_library_v3 import library_v3
from test_knowledge_sources import F1, F2, headers, ks, records, saved_document

from app.api.v1 import knowledge_source_library_v3 as library_api
from app.services.information import bridge
from app.services.knowledge_source_folders import folder_action, organize_papers
from app.services.knowledge_source_inbox import inbox_id, normalized_folder_ids

INBOX = {"id": "44444444-4444-4444-8444-444444444444", "name": "待整理", "systemRole": "inbox"}


def test_inbox_creation_is_explicit_idempotent_and_requires_live_write_access(ks, monkeypatch):
    client, _, session, _, state, calls = ks
    original = bridge.call

    def connect(operation, subject, **values):
        if operation != "ensureInboxFolder":
            return original(operation, subject, **values)
        calls.append((operation, subject, values))
        if not state["canWrite"]:
            raise bridge.BridgeError(403, "当前知识库角色没有文件夹整理权限")
        if not any(folder["id"] == INBOX["id"] for folder in state["folders"]):
            state["folders"].append(copy.deepcopy(INBOX))
            state["revision"] += 1
        return copy.deepcopy(INBOX)

    monkeypatch.setattr(bridge, "call", connect)
    assert client.get("/api/v1/knowledge-sources/snapshot", headers=session()).status_code == 200
    assert all(operation != "ensureInboxFolder" for operation, _, _ in calls)
    url = "/api/v1/knowledge-sources/folders/inbox"
    assert client.post(url, headers=session(), json={}).status_code == 403
    for _ in range(2):
        response = client.post(url, headers=headers(session), json={})
        assert response.status_code == 200, response.text
        assert response.json() == INBOX
    assert state["revision"] == 1
    assert sum(folder["id"] == INBOX["id"] for folder in state["folders"]) == 1
    state["canWrite"] = False
    assert client.post(url, headers=headers(session), json={}).status_code == 403
    assert state["revision"] == 1


def test_inbox_cannot_be_renamed_from_portal(ks):
    client, _, session, _, state, calls = ks
    state["folders"].append(INBOX)
    response = client.patch(
        "/api/v1/knowledge-sources/folders/" + INBOX["id"],
        headers=headers(session),
        json={"name": "改名", "revision": 0},
    )
    assert response.status_code == 409
    assert all(operation != "folderMutation" for operation, _, _ in calls)


def test_inbox_creation_preserves_bridge_permission_denial(ks, monkeypatch):
    client, _, session, _, state, _ = ks
    original = bridge.call

    def connect(operation, subject, **values):
        if operation == "ensureInboxFolder":
            raise bridge.BridgeError(403, "知识库负责人权限已失效")
        return original(operation, subject, **values)

    monkeypatch.setattr(bridge, "call", connect)
    response = client.post(
        "/api/v1/knowledge-sources/folders/inbox", headers=headers(session), json={}
    )
    assert response.status_code == 403
    assert len(state["folders"]) == 2


def test_inbox_query_includes_unfiled_archive_but_not_ich(library_v3):
    client, db, session, _, state, calls, rows, _ = library_v3
    rows.clear()
    state["folders"].append(INBOX)
    stored, _, document, version = saved_document(db)
    document["folderIds"] = []
    stored.put("document", document)
    db.commit()
    summary = client.get(
        "/api/v1/knowledge-sources/snapshot?summary=true", headers=session()
    ).json()
    assert summary["folderCounts"][INBOX["id"]] == 1
    response = client.post(
        "/api/v1/knowledge-sources/v3/library/query",
        headers=headers(session),
        json={"folderId": INBOX["id"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["papers"][0]["id"] == "archive:" + version["id"]
    assert response.json()["papers"][0]["folderIds"] == [INBOX["id"]]
    query = [values for operation, _, values in calls if operation == "queryLibrary"][-1]
    assert query["unfiled"] is True and query["folderIds"] == []

    document["folderIds"] = [F1]
    stored.put("document", document)
    db.commit()
    response = client.post(
        "/api/v1/knowledge-sources/v3/library/query",
        headers=headers(session),
        json={"folderId": INBOX["id"]},
    )
    assert response.json()["papers"] == []


def test_membership_normalization_preserves_all_organized_folders():
    state = {"folders": [INBOX, {"id": F1, "name": "ICH"}, {"id": F2, "name": "研究"}]}
    assert inbox_id(state) == INBOX["id"]
    assert normalized_folder_ids([], state) == [INBOX["id"]]
    assert normalized_folder_ids(["deleted-folder"], state) == [INBOX["id"]]
    assert normalized_folder_ids([INBOX["id"], F1, F2], state) == [F1, F2]


def test_manual_default_upload_is_visible_in_actual_inbox_and_repeated_filing_clears_inbox(
    library_v3, monkeypatch
):
    from app.services import knowledge_source_workspace_v3 as workspaces

    client, db, session, _, state, _, rows, _ = library_v3
    rows.clear()
    monkeypatch.setattr(library_api, "extract_pdf", lambda path: "Uploaded article")
    original_workspace = workspaces.workspace
    monkeypatch.setattr(
        workspaces,
        "workspace",
        lambda *args: pytest.fail("Default upload must remain in the inbox"),
    )
    url = "/api/v1/knowledge-sources/v3/upload"
    upload = {"file": ("article.pdf", b"%PDF-pending-article", "application/pdf")}
    first = client.post(url, headers=headers(session), files=upload, data={"parse": "false"})
    assert first.status_code == 201, first.text
    assert first.json()["folderId"] == INBOX["id"]
    monkeypatch.setattr(workspaces, "workspace", original_workspace)
    papers = client.post(
        "/api/v1/knowledge-sources/v3/library/query",
        headers=headers(session),
        json={"folderId": INBOX["id"]},
    ).json()["papers"]
    assert len(papers) == 1 and papers[0]["id"] == first.json()["paperId"]
    stored = records(db)
    document = stored.documents()[0]
    classification_id = stored.key("ks_classification", document["id"])
    stored.put(
        "ks_classification",
        {"id": classification_id, "documentId": document["id"], "folderIds": [INBOX["id"]]},
    )
    db.commit()
    second = client.post(
        url, headers=headers(session), files=upload, data={"parse": "false", "folderId": F1}
    )
    assert second.status_code == 201, second.text
    assert stored.documents()[0]["folderIds"] == [F1]
    assert stored.get("ks_classification", classification_id)["folderIds"] == [F1]
    papers = client.post(
        "/api/v1/knowledge-sources/v3/library/query",
        headers=headers(session),
        json={"folderId": INBOX["id"]},
    ).json()["papers"]
    assert papers == []


def test_archived_paper_leaves_inbox_on_filing_and_returns_after_last_removal(store):
    stored, _ = store
    state = {"revision": 0, "folders": [INBOX, {"id": F1, "name": "ICH"}]}
    stored.put("document", {"id": "inbox-doc", "folderIds": [INBOX["id"]]})
    paper = {"id": "archive:local", "documentId": "inbox-doc", "folderIds": [INBOX["id"]]}

    def no_core_mutation(*args, **kwargs):
        pytest.fail("Original without a Core path needs only persisted classification")

    organize_papers(
        stored,
        {"subject": "person"},
        {"paperIds": [paper["id"]], "folderIds": [F1], "mode": "add", "revision": 0},
        catalogue=state,
        connect=no_core_mutation,
        papers=[paper],
    )
    classification_id = stored.key("ks_classification", "inbox-doc")
    assert stored.get("ks_classification", classification_id)["folderIds"] == [F1]
    paper["folderIds"] = [F1]
    organize_papers(
        stored,
        {"subject": "person"},
        {
            "paperIds": [paper["id"]],
            "folderIds": [],
            "fromFolderId": F1,
            "mode": "remove",
            "revision": 0,
        },
        catalogue=state,
        connect=no_core_mutation,
        papers=[paper],
    )
    assert stored.get("ks_classification", classification_id)["folderIds"] == [INBOX["id"]]


def test_deleting_last_normal_folder_returns_archived_paper_to_inbox(store):
    stored, _ = store
    state = {"revision": 0, "folders": [INBOX, {"id": F1, "name": "研究"}]}
    stored.put("document", {"id": "inbox-doc", "folderIds": [F1]})

    def connect(operation, subject, **values):
        assert operation == "folderMutation"
        assert values["mutation"]["operation"] == "delete"
        return {"revision": 1, "folders": [INBOX]}

    folder_action(
        stored,
        {"subject": "person"},
        F1,
        {"action": "delete", "revision": 0},
        catalogue=state,
        connect=connect,
    )
    assert stored.get("document", "inbox-doc")["folderIds"] == [INBOX["id"]]
