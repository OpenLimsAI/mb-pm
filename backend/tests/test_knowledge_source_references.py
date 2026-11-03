# ruff: noqa: F811
"""Saved citation transfers preserve authority and reuse durable archives/jobs."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from test_information_api import live  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_sources import headers, ks, records  # noqa: F401

from app.core.config import settings
from app.models.assistant import AssistantMessage, AssistantTask
from app.models.solution import KnowledgeSolution, SolutionAnswer, SolutionTopic
from app.services.information import worker

ROOT = "/api/v1/knowledge-sources"


def saved_answer(
    db,
    origin="solutions",
    *,
    owner="information-only",
    issuer=None,
    url="https://paper.example.org/article",
):
    issuer = issuer or settings.casdoor_issuer
    refs = [
        {
            "id": "ref-1",
            "title": "Public study",
            "url": url,
            "excerpt": "public snippet",
            "published_at": "2026-01-01",
        }
    ]
    if origin == "solutions":
        parent = KnowledgeSolution(
            id="report-1",
            issuer=issuer,
            owner_id=owner,
            owner_name="Author",
            title="PRIVATE REPORT TITLE",
        )
        answer = SolutionAnswer(
            id="answer-1",
            solution_id=parent.id,
            issuer=issuer,
            owner_id=owner,
            conversation_id="topic-1",
            question="private question",
            content="private answer",
            mode="model",
            scope="",
            web_references=refs,
        )
    else:
        parent = AssistantTask(
            id="task-1", issuer=issuer, owner_id=owner, title="PRIVATE TASK TITLE"
        )
        answer = AssistantMessage(
            id="message-1",
            task_id=parent.id,
            request_id="request-1",
            position=1,
            role="assistant",
            content="private answer",
            web_references=refs,
        )
    db.add(parent)
    db.flush()
    db.add(answer)
    db.commit()
    return (
        {"originApp": origin, "originId": parent.id, "answerId": answer.id, "referenceId": "ref-1"},
        parent,
        answer,
    )


@pytest.mark.parametrize(
    "origin,category", [("solutions", "研究报告参考论文"), ("assistant", "个人AI助手参考论文")]
)
def test_durable_import_dedup_no_download_or_private_text(ks, origin, category):
    client, db, session, role, _, calls = ks
    body, _, _ = saved_answer(db, origin)
    role["value"] = "kb_viewer"
    first = client.post(ROOT + "/references", headers=headers(session), json=body)
    assert first.status_code == 201, first.text
    result = first.json()
    assert result["category"] == category and result["canDownload"] is False
    assert (
        result["folderId"] is None
        and result["status"] == "imported"
        and not result["alreadyImported"]
        and "jobId" not in result
    )
    repeat = client.post(ROOT + "/references", headers=headers(session), json=body).json()
    assert repeat["alreadyImported"] and repeat["documentId"] == result["documentId"]
    s = records(db)
    assert len(s.documents()) == 1 and s.records("job") == [] and calls == []
    snap = client.get(ROOT + "/snapshot", headers=session()).json()
    doc = next(d for d in snap["documents"] if d["id"] == result["documentId"])
    assert doc["title"] == "Public study" and doc["url"] == "https://paper.example.org/article"
    assert "PRIVATE" not in str(snap) and "private answer" not in str(snap)
    assert any(s["adapter"] == "reference" for s in snap["sources"])


@pytest.mark.parametrize(
    "owner,issuer", [("other-owner", None), ("information-only", "https://another-issuer.example")]
)
def test_identity_isolation(ks, owner, issuer):
    client, db, session, _, _, _ = ks
    body, _, _ = saved_answer(db, owner=owner, issuer=issuer)
    assert client.post(ROOT + "/references", headers=headers(session), json=body).status_code == 404
    assert records(db).documents() == []


@pytest.mark.parametrize("origin", ["solutions", "assistant"])
def test_deleted_parent_and_fake_reference(ks, origin):
    client, db, session, _, _, _ = ks
    body, parent, _ = saved_answer(db, origin)
    assert (
        client.post(
            ROOT + "/references", headers=headers(session), json={**body, "referenceId": "unknown"}
        ).status_code
        == 404
    )
    parent.deleted_at = datetime.now(UTC)
    db.commit()
    assert client.post(ROOT + "/references", headers=headers(session), json=body).status_code == 404


def test_deleted_topic_and_client_url_forbidden(ks):
    client, db, session, _, _, _ = ks
    body, parent, _ = saved_answer(db)
    assert (
        client.post(
            ROOT + "/references",
            headers=headers(session),
            json={**body, "url": "https://evil.example/x.pdf"},
        ).status_code
        == 422
    )
    db.add(SolutionTopic(solution_id=parent.id, id="topic-1", title="gone", deleted=True))
    db.commit()
    assert client.post(ROOT + "/references", headers=headers(session), json=body).status_code == 404


def test_download_needs_manager_and_live_write_permission(ks):
    client, db, session, role, state, _ = ks
    body, _, _ = saved_answer(db)
    body["download"] = True
    role["value"] = "kb_viewer"
    assert client.post(ROOT + "/references", headers=headers(session), json=body).status_code == 403
    role["value"] = "kb_manager"
    state["canWrite"] = False
    assert client.post(ROOT + "/references", headers=headers(session), json=body).status_code == 403
    assert records(db).records("job") == []
    assert client.post(ROOT + "/references", headers=session(), json=body).status_code == 403
    assert client.post(ROOT + "/references", json=body).status_code == 401


def test_download_category_and_active_job_reused(ks):
    client, db, session, _, state, calls = ks
    body, _, _ = saved_answer(db)
    body["download"] = True
    response = client.post(ROOT + "/references", headers=headers(session), json=body)
    assert response.status_code == 201, response.text
    first = response.json()
    assert first["canDownload"] and first["status"] == "queued" and first["jobId"]
    assert any(f["name"] == "研究报告参考论文" for f in state["folders"])
    repeat = client.post(ROOT + "/references", headers=headers(session), json=body).json()
    assert repeat["jobId"] == first["jobId"] and repeat["alreadyImported"]
    assert len(records(db).records("job")) == 1 and not any(c[0] == "import" for c in calls)
    assert (
        client.post(
            ROOT + f'/sources/{first["sourceId"]}/check', headers=headers(session), json={}
        ).status_code
        == 400
    )


def test_download_roundtrip_and_saved_version_reused(ks, monkeypatch):
    client, db, session, _, state, _ = ks
    body, _, _ = saved_answer(db)
    body["download"] = True
    result = client.post(ROOT + "/references", headers=headers(session), json=body).json()
    s = records(db)
    monkeypatch.setattr(worker, "authority", lambda *a: None)
    downloader = Mock()
    downloader.pdf.return_value = b"%PDF-public-paper"

    def bridge(operation, subject, **values):
        if operation == "library":
            return {"canWrite": True}
        assert (
            operation == "import" and values["title"] == "Public study" and values["scopes"] == []
        )
        assert values["sourceKind"] == "reference"
        state["papers"].append({"path": "sources/research.md", "title": "Public study"})
        return {"indexStatus": "ready", "path": "sources/research.md"}

    worker.run_step(
        s,
        downloader,
        extract=lambda _: "public paper text",
        connector=bridge,
        job_id=result["jobId"],
        app="knowledge-sources",
    )
    assert s.get("job", result["jobId"])["status"] == "completed"
    again = client.post(ROOT + "/references", headers=headers(session), json=body)
    assert again.status_code == 201, again.text
    assert again.json()["status"] == "saved" and "jobId" not in again.json()
    assert (
        len(s.records("job")) == 1
        and len(s.records("version")) == 1
        and downloader.pdf.call_count == 1
    )
    doc = s.document(result["documentId"])
    original = client.get(
        ROOT + f'/documents/{doc["id"]}/versions/{doc["versions"][0]["id"]}/original',
        headers=session(),
    )
    assert original.status_code == 200 and original.content == b"%PDF-public-paper"
    assert "Paper-" in original.headers["content-disposition"]


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/secret",
        "https://8.8.8.8/paper.pdf",
        "https://paper.example/paper.pdf",
        "https://paper.onion/paper.pdf",
    ],
)
def test_saved_private_url_rejected(ks, url):
    client, db, session, _, _, _ = ks
    body, _, _ = saved_answer(db, url=url)
    assert client.post(ROOT + "/references", headers=headers(session), json=body).status_code == 400
    assert records(db).documents() == []


def test_worker_chooses_reference_downloader_without_resuming_ich(ks, monkeypatch):
    from app.services import knowledge_source_worker

    client, db, session, _, _, _ = ks
    body, _, _ = saved_answer(db)
    result = client.post(
        ROOT + "/references", headers=headers(session), json={**body, "download": True}
    ).json()
    reference, official_factory = Mock(), Mock()

    def step(store, selected, **values):
        assert selected is reference and values["job_id"] == result["jobId"]
        return False

    class Proxy:
        def __getattr__(self, key):
            return getattr(db, key)

        def close(self):
            pass

    monkeypatch.setattr(knowledge_source_worker, "run_step", step)
    knowledge_source_worker.tick(lambda: Proxy(), official_factory, lambda: reference)
    official_factory.assert_not_called()
    reference.close.assert_called_once()


def test_download_worker_off_keeps_metadata_import_available(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    body, _, _ = saved_answer(db)
    monkeypatch.setattr(settings, "KNOWLEDGE_SOURCE_WORKER_ENABLED", False)
    assert (
        client.post(
            ROOT + "/references", headers=headers(session), json={**body, "download": True}
        ).status_code
        == 503
    )
    assert client.post(ROOT + "/references", headers=headers(session), json=body).status_code == 201
    assert records(db).records("job") == []


def test_resume_failed_parse_uses_retained_pdf_without_download(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    body, _, _ = saved_answer(db)
    result = client.post(ROOT + "/references", headers=headers(session), json=body).json()
    s = records(db)
    version = s.archive(
        result["documentId"], b"%PDF-retained", parse_status="failed", error="parse failed"
    )
    db.commit()
    retry = client.post(
        ROOT + "/references", headers=headers(session), json={**body, "download": True}
    ).json()
    item = s.get("job", retry["jobId"])["items"][0]
    assert item["versionId"] == version["id"] and item["phase"] == "resume_saved"
    downloader = Mock()
    monkeypatch.setattr(worker, "authority", lambda *a: None)
    worker.run_step(
        s,
        downloader,
        extract=lambda _: "recovered text",
        connector=lambda operation, *a, **k: {"canWrite": True}
        if operation == "library"
        else {"indexStatus": "ready"},
        job_id=retry["jobId"],
        app="knowledge-sources",
    )
    downloader.pdf.assert_not_called()
    assert s.get("job", retry["jobId"])["status"] == "completed"


def test_batch_download_reuses_retained_original_and_existing_queue(ks):
    client, db, session, _, _, _ = ks
    body, _, _ = saved_answer(db)
    result = client.post(ROOT + "/references", headers=headers(session), json=body).json()
    s = records(db)
    version = s.archive(result["documentId"], b"%PDF-retained", parse_status="failed")
    db.commit()
    request = {"sourceId": result["sourceId"], "documentIds": [result["documentId"]], "parse": True}
    first = client.post(ROOT + "/jobs", headers=headers(session), json=request)
    assert first.status_code == 202, first.text
    repeat = client.post(ROOT + "/jobs", headers=headers(session), json=request)
    assert repeat.json()["id"] == first.json()["id"]
    item = s.get("job", first.json()["id"])["items"][0]
    assert item["versionId"] == version["id"] and item["phase"] == "resume_saved"


def test_revoked_kb_write_grant_pauses_reference_job_before_download(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    body, _, _ = saved_answer(db)
    result = client.post(
        ROOT + "/references", headers=headers(session), json={**body, "download": True}
    ).json()
    s = records(db)
    monkeypatch.setattr(worker, "authority", lambda *a: None)
    download = Mock()
    worker.run_step(
        s,
        download,
        connector=lambda *a, **k: {"canWrite": False},
        job_id=result["jobId"],
        app="knowledge-sources",
    )
    download.pdf.assert_not_called()
    assert s.get("job", result["jobId"])["status"] == "paused"


def test_concurrent_first_category_import_does_not_reset_existing_folder(ks, monkeypatch):
    from types import SimpleNamespace

    from app.services import knowledge_source_references

    _, db, _, _, _, _ = ks
    s = records(db)
    body = SimpleNamespace(origin_app="solutions")
    ref = {"title": "Study", "url": "https://paper.example.org/article", "publishedAt": ""}
    source, _, _ = knowledge_source_references.ensure_reference(s, body, ref)
    source["folderId"] = "existing-folder"
    s.put("source", source)
    db.commit()
    original_get = s.get
    first = True

    def stale_read(kind, ident, **kwargs):
        nonlocal first
        if kind == "source" and first:
            first = False
            return None
        return original_get(kind, ident, **kwargs)

    monkeypatch.setattr(s, "get", stale_read)
    result, _, duplicate = knowledge_source_references.ensure_reference(s, body, ref)
    assert result["folderId"] == "existing-folder" and duplicate
    assert len(s.records("source")) == 1
