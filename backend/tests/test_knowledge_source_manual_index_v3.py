# ruff: noqa: F811
"""Manual index requires explicit consent and real, bound Core task completion."""

import copy
import time
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from test_information_api import live  # noqa: F401
from test_information_live import catalogue, store  # noqa: F401
from test_information_portal import information_portal  # noqa: F401
from test_knowledge_sources import F1, headers, ks, records  # noqa: F401

from app.api.v1 import knowledge_source_manual_index_v3 as api
from app.main import app
from app.services import knowledge_source_manual_index_v3 as manual
from app.services import knowledge_source_worker
from app.services.information import bridge
from app.services.information.store import iso
from app.services.knowledge_source_status import resources

BASE = "/api/v1/knowledge-sources/v3/library/manual-index"
if not any(getattr(route, "path", "") == BASE for route in app.routes):
    app.include_router(api.router, prefix="/api/v1")


@pytest.fixture
def manual_ks(ks, monkeypatch):
    client, db, session, role, state, calls = ks
    role["value"] = "kb_manager"
    store = records(db)
    source_id = store.key("source", "manual-upload")
    document_id = store.key("document", "manual:fixture")
    source = {
        "id": source_id,
        "adapter": "manual",
        "name": "手动收录",
        "scopes": [],
        "enabled": False,
    }
    document = {
        "id": document_id,
        "sourceId": source_id,
        "title": "Manual PDF",
        "url": "",
        "scopes": [],
        "folderIds": [F1],
        "status": "archived",
        "discoveredAt": iso(),
    }
    store.put("source", source)
    store.put("document", document)
    version = store.archive(
        document_id,
        b"%PDF-1.7 saved manual original",
        "Existing extracted text",
        parse_status="ready",
    )
    version.update(
        kbPath="sources/manual.md",
        kbDocumentId="d" * 64,
        kbPending=True,
        indexStatus="not_requested",
    )
    store.put("version", version)
    state["pendingArchives"] = [
        {
            "path": version["kbPath"],
            "documentId": version["kbDocumentId"],
            "sha256": version["sha256"],
            "indexStatus": "not_requested",
        }
    ]
    options = {
        "state": "pending",
        "registered": False,
        "taskId": "real-core-task",
        "active": False,
        "error": None,
    }
    old = bridge.call

    def connector(operation, subject, **values):
        if operation == "library":
            if options["active"]:
                value = copy.deepcopy(state)
                value["papers"].append({"path": version["kbPath"], "title": "Manual PDF"})
                return value
            return old(operation, subject, **values)
        if operation in {"indexUploadedPaper", "statusUploadedPaper"}:
            calls.append((operation, subject, values))
            assert values["documentId"] == version["kbDocumentId"]
            assert values["sha256"] == version["sha256"]
            return {
                "path": version["kbPath"],
                "indexStatus": options["state"],
                "registered": options["registered"],
                "taskId": options["taskId"],
                "error": options["error"],
            }
        return old(operation, subject, **values)

    monkeypatch.setattr(bridge, "call", connector)
    db.commit()
    clock = [time.time()]
    monkeypatch.setattr(manual.time, "time", lambda: clock[0])
    return client, db, session, role, state, calls, version, options, clock


def start(fixture):
    client, _, session, _, _, _, version, _, _ = fixture
    response = client.post(
        BASE,
        headers=headers(session),
        json={"paperId": "archive:" + version["id"], "confirmed": True},
    )
    assert response.status_code == 202, response.text
    return response.json()["jobId"]


def test_manual_index_never_starts_on_get_or_without_strict_confirmation(manual_ks):
    client, db, session, _, _, calls, version, _, _ = manual_ks
    response = client.get(
        BASE + "/status", headers=session(), params={"paperId": "archive:" + version["id"]}
    )
    assert response.status_code == 200 and response.json()["status"] == "not_started"
    for confirmed in (False, "true", 1, None):
        assert (
            client.post(
                BASE,
                headers=headers(session),
                json={"paperId": "archive:" + version["id"], "confirmed": confirmed},
            ).status_code
            == 422
        )
    assert records(db).records("job") == []
    assert not any(op == "indexUploadedPaper" for op, _, _ in calls)


def test_platform_admin_and_editor_cannot_start_manual_global_index(manual_ks):
    client, _, session, role, _, calls, version, _, _ = manual_ks
    for value in ("admin", "kb_editor", "kb_viewer"):
        role["value"] = value
        response = client.post(
            BASE,
            headers=headers(session),
            json={"paperId": "archive:" + version["id"], "confirmed": True},
        )
        assert response.status_code == 403
    assert not any(op == "indexUploadedPaper" for op, _, _ in calls)


def test_duplicate_confirmation_reuses_one_durable_job_without_starting_core(manual_ks):
    _, db, _, _, _, calls, version, _, _ = manual_ks
    first = start(manual_ks)
    second = start(manual_ks)
    assert first == second
    jobs = records(db).records("job")
    assert len(jobs) == 1 and jobs[0]["kind"] == "manual-index"
    assert (
        jobs[0]["app"] == "knowledge-sources" and jobs[0]["items"][0]["versionId"] == version["id"]
    )
    assert jobs[0]["globalIncremental"] and jobs[0]["confirmedAt"]
    assert not any(op == "indexUploadedPaper" for op, _, _ in calls)


def test_worker_polls_bound_task_and_only_marks_ready_after_active_registration(manual_ks):
    _, db, _, _, _, calls, version, options, clock = manual_ks
    job_id = start(manual_ks)
    store = records(db)
    original = store.archive_path(version).read_bytes()
    assert manual.run_step(store, job_id, connector=bridge.call)
    assert store.get("version", version["id"])["indexStatus"] == "pending"
    assert [op for op, _, _ in calls if op in {"indexUploadedPaper", "statusUploadedPaper"}] == [
        "indexUploadedPaper"
    ]
    clock[0] += 6
    options.update(state="ready", registered=False)
    manual.run_step(store, job_id, connector=bridge.call)
    assert store.get("version", version["id"])["indexStatus"] == "pending"
    clock[0] += 6
    options["registered"] = True
    manual.run_step(store, job_id, connector=bridge.call)
    assert (
        store.get("version", version["id"])["indexStatus"] == "pending"
    )  # no fresh active source proof
    clock[0] += 6
    options["active"] = True
    manual.run_step(store, job_id, connector=bridge.call)
    job = store.get("job", job_id)
    assert job["status"] == "completed" and job["saved"] == 1
    assert store.get("version", version["id"])["indexStatus"] == "ready"
    assert store.archive_path(version).read_bytes() == original
    assert resources(store)["downloadBytes"] == 0 and resources(store)["indexedVersions"] == 1
    assert sum(op == "indexUploadedPaper" for op, _, _ in calls) == 1
    assert not any(op in {"import", "status"} for op, _, _ in calls)


def test_unknown_status_does_not_become_ready_and_failure_preserves_original(manual_ks):
    _, db, _, _, _, _, version, options, clock = manual_ks
    job_id = start(manual_ks)
    store = records(db)
    options["state"] = "unknown"
    manual.run_step(store, job_id, connector=bridge.call)
    assert store.get("job", job_id)["status"] == "running"
    assert store.get("version", version["id"])["indexStatus"] == "pending"
    clock[0] += 6
    options.update(state="failed", error="Actual ingest failed")
    manual.run_step(store, job_id, connector=bridge.call)
    assert store.get("job", job_id)["status"] == "failed"
    assert store.get("version", version["id"])["indexStatus"] == "failed"
    assert store.archive_path(version).is_file()


def test_revoked_manager_and_deleted_source_stop_without_submission(manual_ks):
    _, db, _, role, state, calls, _, _, _ = manual_ks
    job_id = start(manual_ks)
    role["value"] = "admin"
    manual.run_step(records(db), job_id, connector=bridge.call)
    assert records(db).get("job", job_id)["status"] == "paused"
    assert not any(op == "indexUploadedPaper" for op, _, _ in calls)
    role["value"] = "kb_manager"
    # Explicit fresh confirmation resumes the same job; this still does not start Core.
    assert start(manual_ks) == job_id
    state["pendingArchives"] = []
    manual.run_step(records(db), job_id, connector=bridge.call)
    assert records(db).get("job", job_id)["status"] == "failed"
    assert not any(op == "indexUploadedPaper" for op, _, _ in calls)


def test_worker_tick_never_constructs_pdf_clients_for_manual_index(manual_ks):
    _, db, _, _, _, calls, _, _, _ = manual_ks
    job_id = start(manual_ks)
    factory = Mock(side_effect=AssertionError("manual indexing must not download PDF"))
    knowledge_source_worker.tick(
        session_factory=lambda: Session(db.get_bind()),
        official_factory=factory,
        reference_factory=factory,
    )
    factory.assert_not_called()
    assert records(db).get("job", job_id)["status"] == "running"
    assert any(op == "indexUploadedPaper" for op, _, _ in calls)


def test_task_id_mismatch_never_marks_an_unrelated_task_success(manual_ks):
    _, db, _, _, _, _, version, options, clock = manual_ks
    job_id = start(manual_ks)
    store = records(db)
    manual.run_step(store, job_id, connector=bridge.call)
    clock[0] += 6
    options.update(taskId="different-task", state="ready", registered=True, active=True)
    manual.run_step(store, job_id, connector=bridge.call)
    assert store.get("job", job_id)["status"] == "failed"
    assert store.get("version", version["id"])["indexStatus"] != "ready"


@pytest.mark.parametrize("action", ["pause", "cancel", "resume", "retry"])
def test_generic_download_controls_cannot_stop_or_resubmit_core_index(manual_ks, action):
    client, db, session, _, _, calls, _, _, _ = manual_ks
    job_id = start(manual_ks)
    before = records(db).get("job", job_id)
    response = client.post(
        f"/api/v1/knowledge-sources/jobs/{job_id}/control",
        headers=headers(session),
        json={"action": action},
    )
    assert response.status_code == 409, response.text
    assert "知识库级索引" in response.json()["detail"]
    assert records(db).get("job", job_id) == before
    assert not any(op in {"indexUploadedPaper", "statusUploadedPaper"} for op, _, _ in calls)
