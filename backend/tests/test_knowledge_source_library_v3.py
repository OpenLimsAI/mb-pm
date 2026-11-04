# ruff: noqa: F811
import copy
import hashlib
import io
import json
import zipfile

import pytest
from test_information_api import live  # noqa: F401
from test_information_live import catalogue, store  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_sources import F1, P1, headers, ks, records, saved_document  # noqa: F401

from app.api.v1 import knowledge_source_library_v3 as api
from app.models.note import PersonalNote
from app.services.information import bridge
from app.services.information.store import iso


@pytest.fixture
def library_v3(ks, monkeypatch):
    client, db, session, role, state, calls = ks
    old = bridge.call
    rows = [
        {
            "path": f"sources/paper-{i:04}.md",
            "title": f"Paper {i:04}",
            "folderIds": [F1],
            "metadata": {},
            "tags": ["质量"],
            "createdAt": f"2020-11-{30 - i // 100:02}T00:00:00Z",
        }
        for i in range(155)
    ]
    state.update(tagsCatalog=["质量"], pendingArchives=[])
    options = {"denied": False, "canWrite": True, "metadataRevision": 3}

    def connect(operation, subject, **values):
        if operation in {
            "librarySummary",
            "queryLibrary",
            "readPaper",
            "readOriginal",
            "updatePaperTags",
            "updatePaperMetadata",
            "uploadPaper",
        }:
            calls.append((operation, subject, values))
            if options["denied"]:
                raise bridge.BridgeError(403, "知识库阅读权限已失效")
            if operation == "librarySummary":
                return {**copy.deepcopy(state), "total": len(rows), "canWrite": options["canWrite"]}
            if operation == "queryLibrary":
                selected = [
                    p for p in rows if "paths" not in values or p["path"] in values["paths"]
                ]
                offset, limit = values.get("offset", 0), values.get("limit", 50)
                return {
                    "papers": copy.deepcopy(selected[offset : offset + limit]),
                    "total": len(selected),
                    "revision": 2,
                    "nextOffset": offset + limit if offset + limit < len(selected) else None,
                    "searchIndex": {
                        "indexing": True,
                        "complete": False,
                        "indexed": 3,
                        "total": len(rows),
                        "failed": 0,
                    },
                    "incomplete": True,
                }
            if operation == "readPaper":
                return {
                    **rows[0],
                    "path": values["path"],
                    "body": "quality evidence",
                    "hash": "abc",
                    "totalLength": 16,
                    "offset": 0,
                    "insightRevision": 3,
                    "metadataRevision": 3,
                    "canWrite": True,
                    "originals": [{"attachmentId": "a" * 64}],
                }
            if operation == "readOriginal":
                return {"base64": "bm90LXBkZg=="}
            if operation == "uploadPaper":
                digest = values["sha256"]
                proof = {
                    "documentId": "d" * 64,
                    "sha256": digest,
                    "path": "sources/upload.md",
                    "indexStatus": "not_requested",
                }
                state["pendingArchives"] = [proof]
                return {
                    **proof,
                    "folderId": F1,
                    "registered": False,
                    "url": "https://kb.example/?paper=upload",
                }
            if values.get("revision") != options["metadataRevision"]:
                raise bridge.BridgeError(409, "资料已更新")
            return {"saved": True, "revision": 4}
        return old(operation, subject, **values)

    monkeypatch.setattr(bridge, "call", connect)
    return client, db, session, role, state, calls, rows, options


def test_page_two_does_not_load_page_one_or_full_snapshot(library_v3):
    client, _, session, _, _, calls, _, _ = library_v3
    result = client.post(
        "/api/v1/knowledge-sources/v3/library/query",
        headers=headers(session),
        json={"offset": 50, "limit": 50},
    ).json()
    assert result["papers"][0]["id"].endswith("paper-0050.md")
    assert result["total"] == 155 and len(result["papers"]) == 50
    assert [(v["offset"], v["limit"]) for op, _, v in calls if op == "queryLibrary"] == [(50, 50)]
    assert not any(op == "library" for op, _, _ in calls)
    assert result["incomplete"] and result["searchIndex"]["indexed"] == 3
    assert result["papers"][0]["tags"] == [{"id": "质量", "name": "质量"}]


def test_summary_does_not_fetch_all_library_papers(library_v3):
    client, _, session, _, _, calls, _, _ = library_v3
    response = client.get("/api/v1/knowledge-sources/snapshot?summary=true", headers=session())
    assert response.status_code == 200
    assert response.json()["libraryV3"] and response.json()["papers"] == []
    assert not any(op == "library" for op, _, _ in calls)


def test_detail_preserves_offsets_revisions_and_protected_original(library_v3):
    client, _, session, _, _, _, rows, _ = library_v3
    response = client.post(
        "/api/v1/knowledge-sources/v3/library/detail",
        headers=headers(session),
        json={"paperId": rows[0]["path"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["text"] == "quality evidence" and data["totalCharacters"] == 16
    assert data["metadataRevision"] == 3 and "attachmentId=" in data["originalUrl"]


def test_original_rejects_non_pdf_bridge_payload(library_v3):
    client, _, session, _, _, _, rows, _ = library_v3
    response = client.get(
        "/api/v1/knowledge-sources/v3/library/original",
        headers=session(),
        params={"paperId": rows[0]["path"], "attachmentId": "a" * 64},
    )
    assert response.status_code == 502


def test_archive_detail_rechecks_live_kb_permissions(library_v3):
    client, db, session, _, _, _, _, options = library_v3
    _, _, _, version = saved_document(db)
    options["denied"] = True
    result = client.post(
        "/api/v1/knowledge-sources/v3/library/detail",
        headers=headers(session),
        json={"paperId": "archive:" + version["id"]},
    )
    assert result.status_code == 403 and "text" not in result.json()


def test_shared_tags_require_current_insight_revision(library_v3):
    client, _, session, _, _, _, rows, _ = library_v3
    url = "/api/v1/knowledge-sources/v3/library/tags"
    assert (
        client.post(
            url,
            headers=headers(session),
            json={"paperIds": [rows[0]["path"]], "tags": ["稳定性"], "revision": 2},
        ).status_code
        == 409
    )
    assert (
        client.post(
            url,
            headers=headers(session),
            json={"paperIds": [rows[0]["path"]], "tags": ["稳定性"], "revision": 3},
        ).status_code
        == 200
    )


def test_bulk_tags_keep_partial_failures_and_replace_really_replaces(library_v3, monkeypatch):
    client, _, session, _, _, calls, rows, _ = library_v3
    original = bridge.call

    def connect(operation, subject, **values):
        if operation == "updatePaperTags" and values["path"] == rows[1]["path"]:
            raise bridge.BridgeError(409, "其他用户刚更新了这篇标签")
        return original(operation, subject, **values)

    monkeypatch.setattr(bridge, "call", connect)
    result = client.post(
        "/api/v1/knowledge-sources/v3/library/tags",
        headers=headers(session),
        json={
            "paperIds": [p["path"] for p in rows[:2]],
            "tags": ["稳定性"],
            "revision": 0,
            "mode": "replace",
        },
    )
    assert result.status_code == 200
    assert result.json()["partial"] and result.json()["savedCount"] == 1
    assert result.json()["results"][1]["status"] == 409
    assert [v["tags"] for op, _, v in calls if op == "updatePaperTags"] == [["稳定性"]]


def test_manual_upload_preserves_pending_original_and_body(library_v3, monkeypatch):
    client, db, session, _, _, calls, _, _ = library_v3
    monkeypatch.setattr(api, "extract_pdf", lambda path: "local readable text")
    raw = b"%PDF-1.7 manual original"
    result = client.post(
        "/api/v1/knowledge-sources/v3/upload",
        headers=headers(session),
        files={"file": ("manual.pdf", raw, "application/pdf")},
        data={"parse": "false"},
    )
    assert result.status_code == 201, result.text
    assert result.json()["originalSaved"] and not result.json()["registered"]
    store = records(db)
    version = store.get("version", result.json()["paperId"].removeprefix("archive:"))
    assert store.archive_path(version).read_bytes() == raw
    assert version["text"] == "local readable text" and version["kbPending"]
    assert version["sha256"] == hashlib.sha256(raw).hexdigest()
    assert [v for op, _, v in calls if op == "uploadPaper"][0]["parse"] is False
    detail = client.post(
        "/api/v1/knowledge-sources/v3/library/detail",
        headers=headers(session),
        json={"paperId": result.json()["paperId"]},
    )
    assert detail.status_code == 200 and detail.json()["text"] == "local readable text"
    page = client.post(
        "/api/v1/knowledge-sources/v3/library/query", headers=headers(session), json={}
    )
    assert page.status_code == 200 and any(
        p["id"] == result.json()["paperId"] for p in page.json()["papers"]
    )


def test_upload_rejects_reader_before_running_pdf_extractor(library_v3, monkeypatch):
    client, _, session, _, _, _, _, options = library_v3
    options["canWrite"] = False
    monkeypatch.setattr(api, "extract_pdf", lambda path: pytest.fail("reader must not parse PDF"))
    assert (
        client.post(
            "/api/v1/knowledge-sources/v3/upload",
            headers=headers(session),
            files={"file": ("x.pdf", b"%PDF-x")},
        ).status_code
        == 403
    )


def test_note_query_only_includes_current_subject_explicit_links(library_v3):
    client, db, session, _, _, calls, rows, _ = library_v3
    # The real authenticated fixture determines the issuer/subject; direct helper
    # coverage below verifies isolation without depending on a test account name.
    db.add_all(
        [
            PersonalNote(
                id="mine-note",
                issuer="issuer",
                owner_id="me",
                title="quality",
                content="quality finding",
                source_url="https://kb.example/?paper=" + rows[0]["path"],
            ),
            PersonalNote(
                id="other-note",
                issuer="issuer",
                owner_id="someone",
                title="quality",
                content="quality secret",
                source_url="https://kb.example/?paper=" + rows[1]["path"],
            ),
        ]
    )
    db.commit()
    found, truncated = api.note_matches(db, {"issuer": "issuer", "subject": "me"}, "quality", [])
    assert not truncated
    assert set(found) == {rows[0]["path"]}
    assert found[rows[0]["path"]][0]["noteId"] == "mine-note"


def test_collection_intersects_instead_of_overwriting_current_search_and_folder():
    result = api.merge_collection_options(
        {"query": "stability", "folderIds": ["a"], "tags": ["Q"]},
        {"query": "protein", "folderIds": ["a", "b"], "tags": ["method"]},
    )
    assert result["query"] == "stability" and result["extraQueries"] == ["protein"]
    assert result["folderIds"] == ["a"] and set(result["tags"]) == {"Q", "method"}
    assert (
        api.merge_collection_options({"query": "", "folderIds": ["a"]}, {"folderIds": ["b"]})[
            "paths"
        ]
        == []
    )
    assert (
        api.merge_collection_options({"type": "Guideline"}, {"type": "Presentation"})["paths"] == []
    )
    assert api.merge_collection_options({"tags": ["a", "b", "c"]}, {"tags": ["d"]})["paths"] == []


def test_shared_metadata_overrides_older_source_metadata(library_v3):
    _, db, _, _, _, _, _, _ = library_v3
    store, source, document, version = saved_document(db, linked=True)
    document["metadata"] = {"authors": ["Old"], "year": "2020", "doi": "10.1/old"}
    paper = api._map_paper(
        {
            "path": P1,
            "title": "Corrected",
            "metadata": {"authors": ["New"], "year": "2026", "doi": "10.1/new"},
        },
        [version],
        {document["id"]: document},
        {source["id"]: source},
        store,
    )
    assert paper["title"] == "Corrected" and paper["authors"] == ["New"]
    assert paper["year"] == "2026" and paper["doi"] == "10.1/new"
    assert paper["saved"] and paper["originalUrl"]


def test_ich_pending_proof_keeps_unindexed_original_visible(library_v3):
    client, db, session, _, state, _, _, _ = library_v3
    store, _, document, version = saved_document(db)
    version.update(kbPath=P1, indexStatus="not_requested")
    store.put("version", version)
    db.commit()
    state["pendingArchives"] = [
        {
            "documentId": document["id"],
            "sha256": version["sha256"],
            "path": P1,
            "indexStatus": "not_requested",
        }
    ]
    result = client.post(
        "/api/v1/knowledge-sources/v3/library/query", headers=headers(session), json={}
    )
    assert result.status_code == 200
    assert any(p["id"] == "archive:" + version["id"] for p in result.json()["papers"])


def test_pending_originals_and_registered_versions_count_as_one_document(library_v3):
    client, db, session, _, state, _, rows, _ = library_v3
    store, _, document, old = saved_document(db, linked=True)
    latest = store.archive(
        document["id"], b"%PDF-new-body", "new quality text", parse_status="ready"
    )
    latest.update(kbPath="sources/pending-new.md", indexStatus="not_requested", createdAt=iso())
    store.put("version", latest)
    document["verifiedSha256"] = latest["sha256"]
    store.put("document", document)
    db.commit()
    rows[:] = [
        {
            "path": P1,
            "title": "older version",
            "documentId": document["id"],
            "versionId": old["id"],
            "folderIds": [F1],
            "createdAt": "2020-01-01T00:00:00Z",
        }
    ]
    state["folderCounts"] = {F1: 1}
    state["pendingArchives"] = [
        {
            "documentId": document["id"],
            "sha256": latest["sha256"],
            "path": latest["kbPath"],
            "indexStatus": "not_requested",
        }
    ]
    summary = client.get(
        "/api/v1/knowledge-sources/snapshot?summary=true", headers=session()
    ).json()
    assert summary["libraryTotal"] == 1 and summary["folderCounts"][F1] == 1
    result = client.post(
        "/api/v1/knowledge-sources/v3/library/query", headers=headers(session), json={}
    ).json()
    assert result["total"] == 1 and result["papers"][0]["versionId"] == latest["id"]


def test_type_and_index_filters_apply_to_pending_originals_and_kb_query(library_v3):
    client, db, session, _, _, calls, rows, _ = library_v3
    rows.clear()
    _, _, document, version = saved_document(db)
    for kind, status, expected in [
        (document["documentType"], version["indexStatus"], 1),
        ("another type", version["indexStatus"], 0),
        (document["documentType"], "ready", 0),
    ]:
        result = client.post(
            "/api/v1/knowledge-sources/v3/library/query",
            headers=headers(session),
            json={"type": kind, "indexStatus": status},
        )
        assert result.status_code == 200 and result.json()["total"] == expected
        options = next(values for op, _, values in reversed(calls) if op == "queryLibrary")
        assert options["type"] == kind and options["status"] == status


def test_batch_returns_its_version_instead_of_later_local_version(library_v3):
    client, db, session, _, _, _, _, _ = library_v3
    store, source, document, version = saved_document(db)
    store.archive(document["id"], b"%PDF-later", "later text", parse_status="ready")
    ident = store.key("job", "original-batch")
    store.put(
        "job",
        {
            "id": ident,
            "app": "knowledge-sources",
            "sourceId": source["id"],
            "items": [{"documentId": document["id"], "versionId": version["id"]}],
        },
    )
    db.commit()
    result = client.post(
        "/api/v1/knowledge-sources/v3/library/query",
        headers=headers(session),
        json={"folderId": "batch:" + ident},
    )
    assert result.status_code == 200 and result.json()["total"] == 1
    assert result.json()["papers"][0]["versionId"] == version["id"]


def test_zip_exports_same_original_once_with_both_version_records(library_v3):
    client, db, session, _, _, _, _, _ = library_v3
    store, _, document, first = saved_document(db)
    another = {**document, "id": store.key("document", "second-paper"), "title": "Second paper"}
    store.put("document", another)
    second = store.archive(
        another["id"], store.archive_path(first).read_bytes(), "same original", parse_status="ready"
    )
    db.commit()
    result = client.post(
        "/api/v1/knowledge-sources/v3/library/export",
        headers=headers(session),
        json={"paperIds": ["archive:" + first["id"], "archive:" + second["id"]], "format": "zip"},
    )
    assert result.status_code == 200
    with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
        assert len([name for name in archive.namelist() if name.endswith(".pdf")]) == 1
        manifest = json.loads(archive.read("archive-manifest.json"))
        assert len(manifest["documents"]) == 2
        assert {item["status"] for item in manifest["documents"]} == {"saved", "shared_original"}


@pytest.mark.parametrize("format", ["bibtex", "ris"])
def test_pending_citation_exports_keep_available_authors_year_and_doi(library_v3, format):
    client, db, session, _, _, _, _, _ = library_v3
    store, _, document, version = saved_document(db)
    document["metadata"] = {
        "authors": ["Alice Researcher", "Bob Scientist"],
        "year": "2026",
        "doi": "10.1234/paper",
        "journal": "Quality Journal",
        "abstract": "Actual source abstract.",
        "version": "untrusted replacement",
    }
    store.put("document", document)
    db.commit()
    response = client.post(
        "/api/v1/knowledge-sources/v3/library/export",
        headers=headers(session),
        json={"paperIds": ["archive:" + version["id"]], "format": format},
    )
    assert response.status_code == 200
    for value in (
        "Alice Researcher",
        "Bob Scientist",
        "2026",
        "10.1234/paper",
        "Quality Journal",
        "Actual source abstract.",
        version["id"],
    ):
        assert value in response.text
    assert "untrusted replacement" not in response.text
