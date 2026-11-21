# ruff: noqa: F811
"""Deletion bridge contract; no actual customer files or Core service."""

import pytest
from test_information_api import live  # noqa: F401
from test_information_live import catalogue, store  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_sources import headers, ks  # noqa: F401

from app.core.config import settings
from app.models.information import InformationText
from app.services.information import bridge
from app.services.information.store import Store, tenant_key

ROOT = "/api/v1/knowledge-sources/v3/library"
PLAN = "12345678-1234-1234-1234-123456789012"
PATH = "sources/a.md"


@pytest.fixture
def deletion(ks, monkeypatch):
    client, db, session, role, state, calls = ks

    def connect(operation, subject, **values):
        calls.append((operation, subject, values))
        if operation == "deletePaperPreview":
            return {
                "planId": PLAN,
                "path": PATH,
                "title": "A",
                "expiresAt": "2026-12-01T00:00:00Z",
                "pages": [],
                "sharedCount": 0,
                "unverifiedCount": 0,
            }
        return {"operationId": PLAN, "path": PATH, "status": "running", "completed": 0, "total": 1}

    monkeypatch.setattr(bridge, "call", connect)
    return client, session, calls


def test_preview_confirm_and_status_forward_only_exact_authenticated_values(deletion):
    client, session, calls = deletion
    preview = client.post(
        ROOT + "/delete-preview", headers=headers(session), json={"paperId": PATH}
    )
    assert preview.status_code == 200 and preview.json()["planId"] == PLAN
    result = client.post(
        ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": PLAN}
    )
    assert result.status_code == 200 and result.json()["status"] == "running"
    status = client.get(ROOT + "/delete-status", headers=session(), params={"operationId": PLAN})
    assert status.status_code == 200 and status.json()["operationId"] == PLAN
    assert [(op, values) for op, _, values in calls] == [
        ("deletePaperPreview", {"path": PATH}),
        ("deletePaper", {"path": PATH, "planId": PLAN}),
        ("deletePaperStatus", {"operationId": PLAN}),
    ]
    assert len({subject for _, subject, _ in calls}) == 1


@pytest.mark.parametrize(
    "paper",
    [
        "archive:abc",
        "sources/../secret.md",
        "knowledge/a.md",
        "sources/a\\b.md",
        "sources/a.md\x00",
        "sources//a.md",
    ],
)
def test_invalid_or_unregistered_paths_do_not_reach_bridge(deletion, paper):
    client, session, calls = deletion
    assert (
        client.post(
            ROOT + "/delete-preview", headers=headers(session), json={"paperId": paper}
        ).status_code
        == 422
    )
    assert calls == []


def test_delete_requires_origin_session_and_strict_plan_id(deletion):
    client, session, calls = deletion
    assert client.post(ROOT + "/delete-preview", json={"paperId": PATH}).status_code == 401
    assert (
        client.post(ROOT + "/delete-preview", headers=session(), json={"paperId": PATH}).status_code
        == 403
    )
    assert (
        client.post(
            ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": "invalid"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            ROOT + "/delete",
            headers=headers(session),
            json={"paperId": PATH, "planId": PLAN, "subject": "someone-else"},
        ).status_code
        == 422
    )
    assert (
        client.get(
            ROOT + "/delete-status", headers=session(), params={"operationId": "bad"}
        ).status_code
        == 422
    )
    assert calls == []


def test_deleted_owner_or_stale_plan_errors_remain_explicit(deletion, monkeypatch):
    client, session, _ = deletion
    for code in (403, 409):

        def denied(*args, code=code, **kwargs):
            raise bridge.BridgeError(code, "No longer allowed")

        monkeypatch.setattr(bridge, "call", denied)
        result = client.post(
            ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": PLAN}
        )
        assert result.status_code == code


def test_expired_plan_keeps_explicit_code_for_safe_repreview(deletion, monkeypatch):
    client, session, _ = deletion

    def expired(*args, **kwargs):
        raise bridge.BridgeError(409, "Plan expired", "paper_delete_plan_expired")

    monkeypatch.setattr(bridge, "call", expired)
    result = client.post(
        ROOT + "/delete", headers=headers(session), json={"paperId": PATH, "planId": PLAN}
    )
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "paper_delete_plan_expired"


@pytest.mark.parametrize("shared", [False, True])
def test_pending_manual_original_deletion_uses_receipt_and_preserves_shared_file(
    ks, monkeypatch, shared
):
    client, db, session, _, _, calls = ks
    tenant = tenant_key(settings.casdoor_issuer, settings.CASDOOR_ORG)
    store = Store(db, tenant)
    source = store.key("source", "manual-upload")
    store.put("source", {"id": source, "adapter": "manual"})
    document = store.key("document", "test-manual")
    store.put(
        "document",
        {
            "id": document,
            "sourceId": source,
            "documentType": "手动上传",
            "title": "Test PDF",
            "folderIds": [],
        },
    )
    contents = b"%PDF-1.7\nTest PDF original"
    version = store.archive(document, contents, "Extracted text")
    version.update(kbDocumentId="0" * 64, kbPath=PATH)
    store.put("version", version)
    archive = store.archive_path(version)
    if shared:
        other = store.key("document", "another-file")
        store.put(
            "document", {"id": other, "sourceId": source, "title": "Another file", "folderIds": []}
        )
        store.archive(other, contents)
    db.commit()
    assert archive.exists()
    calls.clear()

    reply = {"path": PATH, "discarded": False}

    def receipt(operation, subject, **values):
        calls.append(operation)
        assert values == {"documentId": version["kbDocumentId"], "sha256": version["sha256"]}
        return dict(reply)

    monkeypatch.setattr(bridge, "call", receipt)

    request = {"paperId": "archive:" + version["id"]}
    preview = client.post(ROOT + "/delete-preview", headers=headers(session), json=request)
    assert preview.status_code == 200, preview.text
    assert preview.json()["scope"] == "original" and archive.exists()
    request["planId"] = preview.json()["planId"]
    job = store.create_job(source, "test-manager", kind="manual-index", document_ids=[document])
    job["items"][0]["versionId"] = version["id"]
    store.put("job", job)
    db.commit()
    processing = client.post(ROOT + "/delete", headers=headers(session), json=request)
    assert processing.status_code == 409 and archive.exists()
    store.put("job", {**job, "status": "cancelled"})
    db.commit()
    incomplete = client.post(ROOT + "/delete", headers=headers(session), json=request)
    assert incomplete.status_code == 503 and archive.exists()
    reply["discarded"] = True
    result = client.post(ROOT + "/delete", headers=headers(session), json=request)
    assert result.status_code == 200 and result.json()["status"] == "succeeded"
    assert archive.exists() is shared
    assert store.get("version", version["id"], required=False) is None
    db.expire_all()
    assert db.get(InformationText, version["id"]) is None
    again = client.post(ROOT + "/delete", headers=headers(session), json=request)
    assert again.json() == result.json()
    verified = client.get(
        ROOT + "/delete-status", headers=session(), params={"operationId": request["planId"]}
    )
    assert verified.json() == result.json()
    assert calls == [
        "previewPendingOriginalDelete",
        "deletePendingOriginal",
        "deletePendingOriginal",
    ]
