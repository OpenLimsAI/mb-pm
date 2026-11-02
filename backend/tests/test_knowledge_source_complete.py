# ruff: noqa: F811
"""Batch workspace contracts with isolated files, identity and official responses."""

from unittest.mock import Mock

from test_information_api import live  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_sources import F1, F2, headers, ks, records, saved_document  # noqa: F401

from app.services import knowledge_source_worker
from app.services.information import worker
from app.services.information.store import iso
from app.services.knowledge_source_status import version_state

ROOT = "/api/v1/knowledge-sources"


def test_incremental_jobs_has_no_library_call_and_never_leaks_subject(ks):
    client, db, session, _, _, calls = ks
    s = records(db)
    source = s.ensure_source()
    job = s.create_job(source["id"], "secret-subject", app="knowledge-sources", kind="check")
    db.commit()
    calls.clear()
    result = client.get(ROOT + "/jobs/status", headers=session()).json()
    assert calls == []
    assert result["jobs"][0]["id"] == job["id"]
    assert "actorSubject" not in result["jobs"][0]
    assert result["revision"]
    s.control_job(job["id"], "cancel")
    db.commit()
    assert (
        client.get(ROOT + "/jobs/status", headers=session()).json()["revision"]
        != result["revision"]
    )


def test_read_marker_persists_independently_from_new_and_is_personal(ks):
    client, db, session, _, _, _ = ks
    s, source, doc, _ = saved_document(db)
    doc.update(firstNewAt="2026-01-01T00:00:00+00:00", newInScopes=["Q"])
    s.put("document", doc)
    db.commit()
    before = client.get(ROOT + "/snapshot", headers=session()).json()
    assert before["documents"][0]["unread"] is True
    assert (
        client.post(
            ROOT + "/changes/read", headers=headers(session), json={"documentIds": [doc["id"]]}
        ).status_code
        == 200
    )
    after = client.get(ROOT + "/snapshot", headers=session()).json()
    assert after["documents"][0]["unread"] is False
    assert after["documents"][0]["isNew"] is True
    assert s.preferences("other").get("knowledgeSourceRead") is None
    doc["newInScopes"] = []
    s.put("document", doc)
    db.commit()
    assert (
        client.get(ROOT + "/snapshot", headers=session()).json()["documents"][0]["unread"] is False
    )


def test_verify_same_url_detects_changed_bytes_without_saving_new_version(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    s, source, doc, original = saved_document(db)
    monkeypatch.setattr(worker, "authority", lambda *args: None)
    assert version_state(doc, [original]) == "unverified"
    response = client.post(
        ROOT + f'/sources/{source["id"]}/verify', headers=headers(session), json={}
    )
    assert response.status_code == 202
    official = Mock()
    official.pdf.return_value = b"%PDF-new-body-at-same-url"
    worker.run_step(s, official, job_id=response.json()["id"], app="knowledge-sources")
    assert len(s.records("version")) == 1
    assert s.archive_path(original).read_bytes() == b"%PDF-actual-retained-original"
    result = client.get(ROOT + "/snapshot", headers=session()).json()
    assert result["documents"][0]["versionStatus"] == "update_available"
    assert result["resources"]["downloadBytes"] == len(official.pdf.return_value)
    assert result["resources"]["modelCost"] is None
    official.pdf.return_value = b"%PDF-actual-retained-original"
    job = client.post(
        ROOT + f'/sources/{source["id"]}/verify', headers=headers(session), json={}
    ).json()
    worker.run_step(s, official, job_id=job["id"], app="knowledge-sources")
    assert version_state(s.get("document", doc["id"]), s.records("version")) == "current"


def test_retry_saved_original_only_indexes_and_records_stage(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    s, _, doc, version = saved_document(db)
    monkeypatch.setattr(worker, "authority", lambda *args: None)
    response = client.post(
        ROOT + f'/documents/{doc["id"]}/retry', headers=headers(session), json={}
    )
    jobid = response.json()["id"]
    official = Mock()

    def connector(operation, subject, **values):
        assert operation == "import"
        assert s.get("job", jobid)["items"][0]["phase"] == "index"
        return {"indexStatus": "ready", "path": "sources/reused.md"}

    worker.run_step(s, official, job_id=jobid, app="knowledge-sources", connector=connector)
    official.pdf.assert_not_called()
    job = s.get("job", jobid)
    assert job["status"] == "completed"
    assert job["items"][0]["phase"] == "done"
    assert job["items"][0]["versionId"] == version["id"]
    assert len(s.records("version")) == 1


def test_failed_index_retry_keeps_saved_version_and_does_not_fetch_again(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    s, _, doc, _ = saved_document(db)
    monkeypatch.setattr(worker, "authority", lambda *args: None)
    response = client.post(
        ROOT + f'/documents/{doc["id"]}/retry', headers=headers(session), json={}
    )
    jobid = response.json()["id"]
    official = Mock()
    worker.run_step(
        s,
        official,
        job_id=jobid,
        app="knowledge-sources",
        connector=lambda *a, **k: {"indexStatus": "failed", "error": "index failed"},
    )
    item = s.get("job", jobid)["items"][0]
    assert item["failurePhase"] == "index" and item["versionId"]
    assert (
        client.post(
            ROOT + f"/jobs/{jobid}/control", headers=headers(session), json={"action": "retry"}
        ).status_code
        == 200
    )
    worker.run_step(
        s,
        official,
        job_id=jobid,
        app="knowledge-sources",
        connector=lambda *a, **k: {"indexStatus": "ready"},
    )
    official.pdf.assert_not_called()
    assert s.get("job", jobid)["status"] == "completed"


def test_schedule_is_separate_from_retired_enabled_and_check_only_does_not_download(
    ks, monkeypatch
):
    client, db, session, _, _, _ = ks
    s, source, _, _ = saved_document(db)
    source.update(enabled=True, managerSubject="legacy", nextCheckAt=0)
    s.put("source", source)
    db.commit()
    knowledge_source_worker.schedule_due(db)
    assert s.records("job") == []
    monkeypatch.setattr(knowledge_source_worker, "authority", lambda *args: None)
    response = client.patch(
        ROOT + f'/sources/{source["id"]}',
        headers=headers(session),
        json={"schedule": {"frequency": "daily", "downloadUpdates": False, "indexUpdates": False}},
    )
    assert response.status_code == 200
    source = s.source(source["id"])
    source["schedule"]["nextCheckAt"] = iso(1)
    s.put("source", source)
    db.commit()
    knowledge_source_worker.schedule_due(db)
    knowledge_source_worker.schedule_due(db)
    jobs = s.records("job")
    assert len(jobs) == 1 and jobs[0]["kind"] == "check"
    jobs[0]["status"] = "completed"
    s.put("job", jobs[0])
    db.commit()
    knowledge_source_worker.scheduled_followup(s, jobs[0])
    assert len(s.records("job")) == 1
    projected = client.get(ROOT + "/snapshot", headers=session()).json()["sources"][0]
    assert "scheduleSubject" not in projected and "managerSubject" not in projected
    assert projected["enabled"] is False


def test_schedule_opt_in_requires_download_for_index_and_honors_disable(ks, monkeypatch):
    client, db, session, _, _, _ = ks
    s, source, doc, _ = saved_document(db)
    path = ROOT + f'/sources/{source["id"]}'
    assert (
        client.patch(
            path,
            headers=headers(session),
            json={
                "schedule": {"frequency": "daily", "downloadUpdates": False, "indexUpdates": True}
            },
        ).status_code
        == 400
    )
    monkeypatch.setattr(knowledge_source_worker, "authority", lambda *args: None)
    job = s.create_job(source["id"], "subject", app="knowledge-sources", kind="check")
    job.update(status="completed", scheduled=True, items=[{"scope": "Q", "status": "saved"}])
    s.put("job", job)
    source.update(
        schedule={"frequency": "daily", "downloadUpdates": True, "indexUpdates": False}, folderId=F1
    )
    s.put("source", source)
    db.commit()
    knowledge_source_worker.scheduled_followup(s, job)
    verify = next(j for j in s.records("job") if j["kind"] == "verify")
    assert verify["items"][0]["documentId"] == doc["id"]
    assert (
        client.patch(
            path, headers=headers(session), json={"schedule": {"frequency": "off"}}
        ).status_code
        == 200
    )
    verify["status"] = "completed"
    s.put("job", verify)
    db.commit()
    knowledge_source_worker.scheduled_followup(s, verify)
    assert not any(j["kind"] == "import" for j in s.records("job"))


def test_temporary_download_folder_does_not_reclassify_topic_as_source(ks):
    client, db, session, _, state, _ = ks
    s, source, doc, _ = saved_document(db)
    state["folders"][1]["kind"] = "topic"
    client.get(ROOT + "/snapshot", headers=session())
    assert (
        client.patch(
            ROOT + f'/sources/{source["id"]}', headers=headers(session), json={"folderId": F2}
        ).status_code
        == 200
    )
    result = client.get(ROOT + "/snapshot", headers=session()).json()
    assert result["sources"][0]["archiveFolderId"] == F1
    assert next(f for f in result["folders"] if f["id"] == F2)["kind"] == "topic"


def test_version_metadata_is_snapshot_not_overwritten_by_catalogue(ks):
    _, db, _, _, _, _ = ks
    s, _, doc, version = saved_document(db)
    saved_status = version["officialStatus"]
    doc["officialStatus"] = "Withdrawn"
    s.put("document", doc)
    db.commit()
    assert s.get("version", version["id"])["officialStatus"] == saved_status


def test_cancel_preserves_original_and_old_retry_cannot_overlap_a_new_job(ks):
    client, db, session, _, _, _ = ks
    s, source, doc, version = saved_document(db)
    first = s.create_job(
        source["id"],
        "information-only",
        app="knowledge-sources",
        kind="import",
        document_ids=[doc["id"]],
    )
    db.commit()
    assert (
        client.post(
            ROOT + f'/jobs/{first["id"]}/control',
            headers=headers(session),
            json={"action": "cancel"},
        ).status_code
        == 200
    )
    second = s.create_job(source["id"], "information-only", app="knowledge-sources", kind="check")
    db.commit()
    assert (
        client.post(
            ROOT + f'/jobs/{first["id"]}/control',
            headers=headers(session),
            json={"action": "retry"},
        ).status_code
        == 409
    )
    assert s.get("job", second["id"])["status"] == "queued"
    assert s.archive_path(version).read_bytes() == b"%PDF-actual-retained-original"


def test_schedule_downloads_only_new_or_changed_after_verification(ks, monkeypatch):
    _, db, _, _, _, _ = ks
    s, source, doc, version = saved_document(db)
    monkeypatch.setattr(knowledge_source_worker, "authority", lambda *args: None)
    source.update(
        schedule={"frequency": "daily", "downloadUpdates": True, "indexUpdates": False}, folderId=F1
    )
    s.put("source", source)
    old = s.get("document", doc["id"])
    old.update(verifiedSha256=version["sha256"], verifiedAt=iso())
    s.put("document", old)
    added = {
        **old,
        "id": s.key("document", "added"),
        "key": "added",
        "title": "New",
        "newInScopes": ["Q"],
    }
    added.pop("verifiedSha256")
    s.put("document", added)
    verify = s.create_job(
        source["id"], "subject", app="knowledge-sources", kind="verify", document_ids=[doc["id"]]
    )
    verify.update(status="completed", scheduled=True, successfulScopes=["Q"])
    s.put("job", verify)
    db.commit()
    knowledge_source_worker.scheduled_followup(s, verify)
    imports = [j for j in s.records("job") if j["kind"] == "import"]
    assert len(imports) == 1
    assert [i["documentId"] for i in imports[0]["items"]] == [added["id"]]
    assert imports[0]["parse"] is False
    knowledge_source_worker.scheduled_followup(s, s.get("job", verify["id"]))
    assert len([j for j in s.records("job") if j["kind"] == "import"]) == 1


def test_personal_event_read_projection_and_non_document_summaries(ks):
    client, db, session, _, _, _ = ks
    s, source, doc, _ = saved_document(db)
    s.event("官方状态变化", doc["title"], source["id"], doc["id"])
    s.event("收录汇总", "Batch", source["id"])
    db.commit()
    before = client.get(ROOT + "/snapshot", headers=session()).json()["changes"]
    assert next(e for e in before if e.get("documentId") == doc["id"])["read"] is False
    assert next(e for e in before if not e.get("documentId"))["read"] is True
    client.post(ROOT + "/changes/read", headers=headers(session), json={"documentIds": [doc["id"]]})
    after = client.get(ROOT + "/snapshot", headers=session()).json()["changes"]
    assert next(e for e in after if e.get("documentId") == doc["id"])["read"] is True


def test_partial_verification_never_downloads_stale_change_evidence(ks, monkeypatch):
    _, db, _, _, _, _ = ks
    s, source, doc, _ = saved_document(db)
    monkeypatch.setattr(knowledge_source_worker, "authority", lambda *args: None)
    source.update(
        schedule={"frequency": "daily", "downloadUpdates": True, "indexUpdates": True}, folderId=F1
    )
    s.put("source", source)
    doc.update(verifiedSha256="old-unavailable-remote-sha", verifiedAt=iso(1))
    s.put("document", doc)
    job = s.create_job(
        source["id"], "subject", app="knowledge-sources", kind="verify", document_ids=[doc["id"]]
    )
    job.update(
        status="partial",
        scheduled=True,
        successfulScopes=["Q"],
        items=[{"documentId": doc["id"], "status": "failed"}],
    )
    s.put("job", job)
    db.commit()
    knowledge_source_worker.scheduled_followup(s, job)
    assert not any(j["kind"] == "import" for j in s.records("job"))


def test_logical_document_prefers_verified_version_without_erasing_history(ks):
    client, db, session, _, _, _ = ks
    s, _, doc, first = saved_document(db)
    second = s.archive(doc["id"], b"%PDF-second-version", "new text", parse_status="ready")
    doc = s.get("document", doc["id"])
    # An official URL can revert to the earlier bytes; prefer the verified file.
    doc.update(verifiedSha256=first["sha256"], verifiedAt=iso())
    s.put("document", doc)
    db.commit()
    result = client.get(ROOT + "/snapshot", headers=session()).json()
    versions = [p for p in result["papers"] if p.get("documentId") == doc["id"]]
    assert len(versions) == 2
    assert next(p for p in versions if p["latest"])["versionId"] == first["id"]
    assert s.archive_path(second).exists()
