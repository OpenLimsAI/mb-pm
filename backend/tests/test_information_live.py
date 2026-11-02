"""Real collection contracts: public ICH input, durable jobs, isolation and honest states."""

import hashlib

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.services.information.ich import parse_catalogue, validate_public_url
from app.services.information.store import Store, tenant_key


def catalogue(url="https://database.ich.org/sites/default/files/Q9_Guideline.pdf", status="Step 4"):
    return {
        "items": [
            {
                "mainWidgets": {
                    "items": [
                        {
                            "entityInfo": {"bundle": "guideline"},
                            "items": [
                                {
                                    "code": "Q9(R1)",
                                    "title": "Quality Risk Management",
                                    "status": status,
                                    "details": {"stepDate": "18 January 2023"},
                                    "fileGroups": [
                                        {
                                            "title": "Guideline",
                                            "files": [
                                                {
                                                    "title": "Q9(R1) Guideline",
                                                    "uri": url,
                                                    "mimetype": "application/pdf",
                                                }
                                            ],
                                        }
                                    ],
                                }
                            ],
                        }
                    ]
                }
            }
        ]
    }


@pytest.fixture
def store(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "INFORMATION_DATA_DIR", str(tmp_path))
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    try:
        yield Store(db, tenant_key("https://iam.example", "org")), db
    finally:
        db.close()
        engine.dispose()


def test_official_catalogue_and_stable_document_identity():
    first = parse_catalogue(catalogue(), "Q")
    moved = parse_catalogue(
        catalogue("https://database.ich.org/sites/default/files/Q9_R1_2026.pdf", "Step 5"), "Q"
    )
    assert len(first) == 1
    assert first[0]["key"] == moved[0]["key"]
    assert first[0]["officialStatus"] == "Step 4"
    assert moved[0]["officialStatus"] == "Step 5"
    assert first[0]["officialDate"] == "18 January 2023"
    assert first[0]["url"].endswith(".pdf")


@pytest.mark.parametrize(
    "url",
    [
        "http://database.ich.org/a.pdf",
        "https://database.ich.org.evil.test/a.pdf",
        "https://127.0.0.1/a.pdf",
        "https://database.ich.org@evil.test/a.pdf",
        "https://admin.ich.org/user/login",
        "https://database.ich.org:444/sites/default/files/a.pdf",
    ],
)
def test_download_cannot_be_used_as_open_or_internal_proxy(url):
    with pytest.raises(ValueError):
        validate_public_url(url)


def test_empty_or_changed_official_schema_is_a_failure():
    for value in [{}, {"items": []}, {"items": [{"title": "error"}]}, "<html>error</html>"]:
        with pytest.raises(ValueError):
            parse_catalogue(value, "Q")


def test_check_is_persistent_and_baseline_is_one_summary(store):
    s, db = store
    source = s.ensure_source()
    s.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    db.commit()
    assert len(Store(db, s.tenant).documents()) == 1
    assert len(s.records("event")) == 0  # A baseline must not notify once per historical paper.
    s.finish_check(source["id"], {"Q": {"status": "ok", "count": 1}})
    db.commit()
    assert len(s.records("event")) == 1
    s.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(status="Step 5"), "Q"))
    db.commit()
    assert len(s.records("event")) == 2
    assert s.records("event")[-1]["kind"] == "官方状态变化"


def test_failed_scope_keeps_last_successful_catalogue(store):
    s, db = store
    source = s.ensure_source()
    s.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    db.commit()
    s.finish_check(source["id"], {"Q": {"status": "error", "error": "HTTP 503"}})
    db.commit()
    assert len(s.documents()) == 1
    assert s.source(source["id"])["status"] == "error"
    assert s.source(source["id"])["scopeStatus"]["Q"]["error"] == "HTTP 503"


def test_new_catalogue_marks_persist_and_repeated_success_does_not_reannounce_old_files(store):
    s, db = store
    source = s.ensure_source()
    old = parse_catalogue(catalogue(), "Q")[0]
    s.apply_catalogue(source["id"], "Q", [old])
    s.finish_check(source["id"], {"Q": {"status": "ok", "count": 1}})
    db.commit()
    assert s.documents()[0]["newInScopes"] == []

    added = {**old, "key": "new-paper", "title": "New paper"}
    s.apply_catalogue(source["id"], "Q", [old, added])
    s.finish_check(source["id"], {"Q": {"status": "ok", "count": 2}})
    db.commit()
    paper = next(d for d in Store(db, s.tenant).documents() if d["title"] == "New paper")
    assert paper["newInScopes"] == ["Q"]
    discovered = paper["discoveredAt"]
    version = s.archive(paper["id"], b"%PDF-retained", "retained text", parse_status="ready")
    paper.update(folderIds=["topic"], status="archived")
    s.put("document", paper)
    db.commit()

    # URL/status updates retain logical identity and existing archive/classification.
    changed = {**added, "url": "https://database.ich.org/sites/default/files/new.pdf"}
    s.apply_catalogue(source["id"], "Q", [old, changed])
    s.finish_check(source["id"], {"Q": {"status": "ok", "count": 2}})
    db.commit()
    updated = s.document(paper["id"])
    assert len(s.documents()) == 2
    assert all(not d["newInScopes"] for d in s.documents())
    assert updated["discoveredAt"] == discovered and updated["folderIds"] == ["topic"]
    assert updated["status"] == "archived"
    assert [v["id"] for v in updated["versions"]] == [version["id"]]
    assert s.archive_path(version).read_bytes() == b"%PDF-retained"


def test_partial_check_keeps_failed_scope_new_markers(store, monkeypatch):
    from app.services.information import worker

    s, db = store
    source = s.ensure_source()
    source["scopes"] = ["Q", "S"]
    s.put("source", source)
    q = parse_catalogue(catalogue(), "Q")[0]
    safe = {**q, "key": "safety-existing", "title": "Safety existing", "scopes": ["S"]}
    s.apply_catalogue(source["id"], "Q", [q])
    s.apply_catalogue(source["id"], "S", [safe])
    s.finish_check(source["id"], {code: {"status": "ok", "count": 1} for code in ["Q", "S"]})
    new_q = {**q, "key": "quality-added", "title": "Quality added"}
    new_s = {**safe, "key": "safety-added", "title": "Safety added"}
    s.apply_catalogue(source["id"], "Q", [q, new_q])
    s.apply_catalogue(source["id"], "S", [safe, new_s])
    s.finish_check(source["id"], {code: {"status": "ok", "count": 2} for code in ["Q", "S"]})
    job = s.create_job(source["id"], "authorized-manager", kind="check")
    db.commit()
    monkeypatch.setattr(worker, "authority", lambda *_: None)

    class Official:
        def catalogue(self, code):
            if code == "S":
                raise ValueError("Safety catalogue unavailable")
            return [q, new_q]

    assert worker.run_step(s, Official(), job_id=job["id"])
    assert worker.run_step(s, Official(), job_id=job["id"])
    assert s.get("job", job["id"])["status"] == "partial"
    marks = {doc["title"]: doc["newInScopes"] for doc in s.documents()}
    assert marks["Quality added"] == [] and marks["Safety added"] == ["S"]
    assert s.source(source["id"])["scopeStatus"]["S"]["status"] == "error"
    # A failure in every selected scope must not erase the last successful markers.
    s.finish_check(source["id"], {code: {"status": "error"} for code in ["Q", "S"]})
    db.commit()
    assert {doc["title"]: doc["newInScopes"] for doc in s.documents()} == marks


def test_known_paper_in_another_scope_is_not_a_new_paper_and_missing_items_keep_their_data(store):
    s, db = store
    source = s.ensure_source()
    q = parse_catalogue(catalogue(), "Q")[0]
    safe = {**q, "key": "safety-existing", "title": "Safety existing", "scopes": ["S"]}
    s.apply_catalogue(source["id"], "Q", [q])
    s.apply_catalogue(source["id"], "S", [safe])
    s.finish_check(source["id"], {code: {"status": "ok", "count": 1} for code in ["Q", "S"]})
    added = {**q, "key": "cross-scope", "title": "Cross scope"}
    s.apply_catalogue(source["id"], "Q", [q, added])
    db.commit()
    ident = next(doc["id"] for doc in s.documents() if doc["title"] == "Cross scope")
    assert s.get("document", ident)["newInScopes"] == ["Q"]
    s.apply_catalogue(source["id"], "S", [safe, {**added, "scopes": ["S"]}])
    db.commit()
    paper = s.get("document", ident)
    assert paper["newInScopes"] == ["Q"] and paper["scopes"] == ["Q", "S"]
    s.apply_catalogue(source["id"], "Q", [q])
    db.commit()
    assert s.get("document", ident)["newInScopes"] == []
    assert len(s.documents()) == 3  # A catalogue update does not delete an existing document.


def test_org_and_subject_preferences_are_separate(store):
    s, db = store
    source = s.ensure_source()
    db.commit()
    other = Store(db, tenant_key("https://iam.example", "another-org"))
    with pytest.raises(HTTPException):
        other.source(source["id"])
    s.save_preferences("alice", {"note": "mine", "digest": "暂停提醒"})
    db.commit()
    assert s.preferences("alice")["note"] == "mine"
    assert s.preferences("bob")["note"] == ""


def test_content_addressed_archive_preserves_versions_and_deduplicates(store):
    s, db = store
    source = s.ensure_source()
    s.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    db.commit()
    doc = s.documents()[0]
    a = s.archive(doc["id"], b"%PDF-old", "first content", parse_status="ready")
    db.commit()
    again = s.archive(doc["id"], b"%PDF-old", "first content", parse_status="ready")
    db.commit()
    b = s.archive(doc["id"], b"%PDF-new", "second content", parse_status="ready")
    db.commit()
    assert a["id"] == again["id"] != b["id"]
    assert len(s.document(doc["id"])["versions"]) == 2
    assert s.archive_path(a).read_bytes() == b"%PDF-old"
    assert s.archive_path(b).read_bytes() == b"%PDF-new"
    assert a["sha256"] == hashlib.sha256(b"%PDF-old").hexdigest()


def test_worker_lease_has_single_owner_and_expires(store):
    s, db = store
    assert s.claim_lease("one", now=100)
    assert not s.claim_lease("two", now=101)
    assert s.claim_lease("two", now=500)
    s.release_lease("one")
    assert not s.claim_lease("three", now=501)
    s.release_lease("two")
    assert s.claim_lease("three", now=501)


def test_pending_index_resumes_without_redownloading_or_false_success(store, monkeypatch):
    from app.core.config import settings
    from app.services.information import worker

    s, db = store
    monkeypatch.setattr(
        worker,
        "active_account",
        lambda sub: {"roles": [{"owner": settings.CASDOOR_ORG, "name": "kb_manager"}]},
    )
    source = s.ensure_source()
    source["scopes"] = ["Q"]
    s.put("source", source)
    check = s.create_job(source["id"], "manager")
    db.commit()

    class Official:
        downloads = 0

        def catalogue(self, scope):
            return parse_catalogue(catalogue(), scope)

        def pdf(self, url):
            self.downloads += 1
            return b"%PDF-public-paper"

    official = Official()
    worker.run_step(s, official)
    assert s.get("job", check["id"])["status"] == "completed"
    doc = s.documents()[0]
    job = s.create_job(
        source["id"],
        "manager",
        kind="import",
        document_ids=[doc["id"]],
        folder_id="real-folder",
        parse=True,
    )
    db.commit()
    calls = []

    def connector(operation, subject, **values):
        calls.append(operation)
        return {
            "indexStatus": "pending" if operation == "import" else "ready",
            "taskId": "task-1",
            "path": "sources/ich.md",
            "url": "https://kb.example",
        }

    worker.run_step(s, official, extract=lambda path: "actual extracted text", connector=connector)
    pending = s.get("job", job["id"])
    assert pending["status"] == "running" and pending["processed"] == 0 and pending["saved"] == 1
    assert s.document(doc["id"])["versions"][0]["indexStatus"] == "pending"
    pending["items"][0]["nextAttemptAt"] = 0
    s.put("job", pending)
    db.commit()
    worker.run_step(
        Store(db, s.tenant),
        official,
        extract=lambda path: pytest.fail("already extracted"),
        connector=connector,
    )
    assert s.get("job", job["id"])["status"] == "completed"
    assert calls == ["import", "status"] and official.downloads == 1
    assert s.document(doc["id"])["versions"][0]["indexStatus"] == "ready"


def test_parse_failure_preserves_original_and_retry_keeps_one_version(store, monkeypatch):
    from app.core.config import settings
    from app.services.information import worker

    s, db = store
    monkeypatch.setattr(
        worker,
        "active_account",
        lambda sub: {"roles": [{"owner": settings.CASDOOR_ORG, "name": "admin"}]},
    )
    source = s.ensure_source()
    s.apply_catalogue(source["id"], "Q", parse_catalogue(catalogue(), "Q"))
    db.commit()
    doc = s.documents()[0]
    job = s.create_job(source["id"], "admin", kind="import", document_ids=[doc["id"]])
    db.commit()

    class Official:
        def pdf(self, url):
            return b"%PDF-original"

    def fail(path):
        raise ValueError("PDF requires OCR")

    worker.run_step(s, Official(), extract=fail)
    result = s.get("job", job["id"])
    version = s.document(doc["id"])["versions"][0]
    assert result["failed"] == 1 and result["saved"] == 1
    assert result["items"][0]["error"] == "PDF requires OCR"
    assert s.archive_path(version).read_bytes() == b"%PDF-original"
    s.control_job(job["id"], "retry")
    db.commit()
    worker.run_step(s, Official(), extract=lambda path: "recovered real text")
    assert s.get("job", job["id"])["status"] == "completed"
    assert len(s.document(doc["id"])["versions"]) == 1
    assert s.document(doc["id"])["versions"][0]["parseStatus"] == "ready"


def test_revoked_manager_is_paused_before_network_access(store, monkeypatch):
    from app.services.information import worker

    s, db = store
    source = s.ensure_source()
    job = s.create_job(source["id"], "former-manager")
    db.commit()
    monkeypatch.setattr(worker, "active_account", lambda sub: {"roles": []})

    class NoNetwork:
        def catalogue(self, scope):
            pytest.fail("no network after role revocation")

    worker.run_step(s, NoNetwork())
    assert s.get("job", job["id"])["status"] == "paused"


def test_native_extractor_reads_actual_pdf_bytes(tmp_path):
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    from app.services.information.extract import extract_pdf

    writer = PdfWriter()
    page = writer.add_blank_page(600, 800)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    stream = DecodedStreamObject()
    stream.set_data(
        b"BT /F1 12 Tf 30 700 Td (This real PDF verifies native extraction of original document content. Archived files and extracted text remain separate and traceable.) Tj ET"
    )
    page[NameObject("/Contents")] = writer._add_object(stream)
    path = tmp_path / "public.pdf"
    with path.open("wb") as output:
        writer.write(output)
    assert "original document content" in extract_pdf(path)


def test_monitoring_checks_the_real_catalogue_before_scheduling_file_updates(store):
    s, db = store
    source = s.ensure_source()
    source["scopes"] = ["Q", "M"]
    s.put("source", source)
    db.commit()
    job = s.create_job(source["id"], "manager", kind="monitor")
    db.commit()
    assert [item["scope"] for item in job["items"]] == ["Q", "M"]
    assert job["total"] == 2


def test_duplicate_active_task_is_rejected_and_cancelled_task_can_be_replaced(store):
    s, db = store
    source = s.ensure_source()
    job = s.create_job(source["id"], "manager")
    db.commit()
    with pytest.raises(HTTPException) as error:
        s.create_job(source["id"], "manager")
    assert error.value.status_code == 409
    db.rollback()
    s.control_job(job["id"], "cancel")
    db.commit()
    assert s.create_job(source["id"], "manager")["id"] != job["id"]
