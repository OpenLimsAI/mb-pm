"""Folder imports exercise durable files, real PDF extraction, scoped KB calls and isolation."""

import base64
import hashlib
import io
import json
import os
import time
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pypdf import PdfWriter
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.db.base import Base
from app.services import folder_imports as folders
from app.services.information import bridge
from app.services.information.extract import extract_pdf
from app.services.information.store import Store

ACTOR = {"subject": "folder-owner", "tenant": "folder-test"}
FOLDER = "11111111-1111-4111-8111-111111111111"


def pdf_bytes(number=1):
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=500, height=700)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})}
    )
    stream = DecodedStreamObject()
    stream.set_data(
        f"BT /F1 12 Tf 30 650 Td (Folder import document {number}. This is a unique readable research paper about topic {number}. Evidence {number} confirms the scientific finding and its analytical method.) Tj ET".encode()
    )
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.fixture
def environment(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    monkeypatch.setattr(settings, "INFORMATION_DATA_DIR", str(tmp_path / "archive"))
    monkeypatch.setattr(
        settings,
        "KNOWLEDGE_FOLDER_IMPORT_ROOTS",
        json.dumps([{"id": "mounted", "name": "资料挂载", "path": str(source)}]),
    )
    monkeypatch.setattr(folders, "authority", lambda db, subject: None)
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    store = Store(db, ACTOR["tenant"])
    state = {"canWrite": True, "folders": [{"id": FOLDER, "name": "研究"}], "revision": 0}
    calls, receipts, deleted = [], {}, set()

    def connector(operation, subject, **values):
        calls.append((operation, subject, values))
        if operation == "librarySummary":
            return dict(state)
        if operation == "ensureInboxFolder":
            return {"id": FOLDER, "name": "待整理", "systemRole": "inbox"}
        if operation == "folderImportPaper":
            sha = values["sha256"]
            assert hashlib.sha256(base64.b64decode(values["originalBase64"])).hexdigest() == sha
            if sha in deleted:
                raise bridge.BridgeError(409, "原件已删除，不能恢复", "folder_source_deleted")
            key = (values["taskId"], sha)
            receipt = receipts.setdefault(
                key,
                {
                    "documentId": hashlib.sha256(("kb:" + sha).encode()).hexdigest(),
                    "path": "sources/folder-" + sha + ".md",
                    "sha256": sha,
                    "indexStatus": "not_requested",
                    "registered": False,
                },
            )
            return dict(receipt)
        if operation == "indexFolderPaper":
            assert values.get("sourceKey")
            assert "authorizeKnowledgeBaseIncremental" not in values
            receipt = receipts[(values["importTaskId"], values["sha256"])]
            receipt.update(taskId="index-" + values["sha256"], indexStatus="ready", registered=True)
            return dict(receipt)
        if operation == "statusFolderPaper":
            return dict(receipts[(values["importTaskId"], values["sha256"])])
        raise AssertionError(operation)

    def put(name, content):
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        os.utime(path, (time.time() - 10, time.time() - 10))
        return path

    try:
        yield store, source, connector, calls, state, receipts, deleted, put
    finally:
        db.close()
        engine.dispose()


def config(kind="server", **changes):
    return {
        "name": "研究自动导入",
        "kind": kind,
        "serverRootId": "mounted" if kind == "server" else None,
        "path": "",
        "folderId": FOLDER,
        "includeSubfolders": True,
        "preserveHierarchy": False,
        "maxFileMb": 100,
        "maxFilesPerScan": 1000,
        "schedule": {
            "frequency": "daily",
            "time": "08:00",
            "timezone": "Asia/Shanghai",
            "weekday": 0,
        },
        **changes,
    }


def finish(store, task_id, connector, *, extract=extract_pdf):
    run_id = folders.runs_for(store, task_id)[0]["id"]
    for _ in range(200):
        run = store.get(folders.RUN, run_id)
        if run["status"] not in folders.ACTIVE:
            return run
        folders.process_run(store, run_id, connector, extract)
    raise AssertionError("run did not finish")


def test_first_scan_ten_distinct_parseable_files_then_no_change_does_no_work(environment):
    store, _, connector, calls, _, _, _, put = environment
    for number in range(10):
        put(f"paper-{number}.pdf", pdf_bytes(number))
    task = folders.create_task(store, ACTOR, config(), connector)
    first = finish(store, task["id"], connector)
    assert first["initial"] and first["completed"] == first["new"] == 10
    assert first["status"] == "completed" and first["failed"] == 0
    items = folders.items_for(store, first["id"])
    assert len({i["sha256"] for i in items}) == 10
    assert all(i["indexStatus"] == "ready" and i["paperId"] for i in items)
    assert all(store.archive_path(store.get("version", i["versionId"])).is_file() for i in items)
    assert len([c for c in calls if c[0] == "indexFolderPaper"]) == 10
    count = len(calls)
    folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    second = finish(store, task["id"], connector)
    assert second["unchanged"] == 10 and second["new"] == second["completed"] == 0
    assert not any(
        c[0] in {"folderImportPaper", "indexFolderPaper", "statusFolderPaper"}
        for c in calls[count:]
    )


def test_updates_duplicates_source_deletion_and_saved_history(environment):
    store, source, connector, calls, _, _, _, put = environment
    first_content = pdf_bytes(1)
    put("original.pdf", first_content)
    task = folders.create_task(store, ACTOR, config(), connector)
    assert finish(store, task["id"], connector)["completed"] == 1
    put("copy.pdf", first_content)
    put("original.pdf", pdf_bytes(2))
    for n in (3, 4, 5):
        put(f"new-{n}.pdf", pdf_bytes(n))
    folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    run = finish(store, task["id"], connector)
    assert run["new"] == 4 and run["updated"] == 1 and run["completed"] == 5
    assert len(store.records("version")) == 5  # original byte copy reuses the same archived version
    original = next(f for f in store.records(folders.FILE) if f["relativePath"] == "original.pdf")
    assert len(original["versions"]) == 2
    (source / "original.pdf").unlink()
    folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    assert finish(store, task["id"], connector)["status"] == "completed"
    assert store.get(folders.FILE, original["id"])["sourceMissing"] is True
    assert len(store.records("version")) == 5
    assert all("delete" not in c[0].lower() for c in calls)


def test_parse_failure_keeps_pm_and_kb_original_and_does_not_block_others(environment):
    store, _, connector, calls, _, _, _, put = environment
    put("good.pdf", pdf_bytes(1))
    put("broken.pdf", b"%PDF-invalid-content")
    task = folders.create_task(store, ACTOR, config(), connector)
    run = finish(store, task["id"], connector)
    assert run["status"] == "partial" and run["completed"] == run["failed"] == 1
    bad = next(i for i in folders.items_for(store, run["id"]) if i["status"] == "failed")
    assert bad["originalSaved"] and bad["paperId"] and bad["phase"] == "parse"
    assert (
        store.archive_path(store.get("version", bad["versionId"])).read_bytes()
        == b"%PDF-invalid-content"
    )
    assert len([c for c in calls if c[0] == "indexFolderPaper"]) == 1
    folders.retry_run(store, run["id"], ACTOR, connector, item_ids=[bad["id"]])
    assert (
        finish(store, task["id"], connector, extract=lambda path: "Recovered text" * 10)[
            "completed"
        ]
        == 2
    )


def test_target_removed_and_owner_permission_revoked_pause_without_fallback(environment):
    store, _, connector, calls, state, _, _, put = environment
    put("paper.pdf", pdf_bytes(1))
    task = folders.create_task(store, ACTOR, config(), connector)
    state["folders"] = []
    with pytest.raises(HTTPException) as exc:
        folders.process_run(store, folders.runs_for(store, task["id"])[0]["id"], connector)
    assert exc.value.status_code == 409
    assert not any(c[0] == "folderImportPaper" for c in calls)
    state["canWrite"] = False
    with pytest.raises(HTTPException) as exc:
        folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    assert exc.value.status_code == 403


def test_local_connector_pairing_lease_hash_recovery_and_revoke(environment):
    store, _, connector, _, _, _, _, _ = environment
    task = folders.create_task(store, ACTOR, config("local"), connector)
    pairing = folders.pair_code(store, task["id"], ACTOR, connector)
    paired = folders.pair_connector(
        store.db, pairing["code"], "/local/research", "computer", connector
    )
    assert paired["token"] not in json.dumps(store.records(folders.AGENT))
    with pytest.raises(HTTPException):
        folders.pair_connector(store.db, pairing["code"], "/local/research", "computer", connector)
    store.db.rollback()
    owned, agent, current = folders.connector_actor(store.db, paired["token"], connector)
    poll = folders.connector_poll(owned, agent, current)
    run = folders.connector_run(owned, agent, current, poll["run"]["id"], poll["run"]["lease"])
    with pytest.raises(HTTPException) as exc:
        folders.connector_run(owned, agent, current, run["id"], "bad-lease")
    assert exc.value.status_code == 403
    content = pdf_bytes(8)
    sha = hashlib.sha256(content).hexdigest()
    manifest = [
        {"relativePath": "a.pdf", "size": len(content), "mtime": time.time() - 10, "sha256": sha}
    ]
    assert folders.apply_manifest(owned, current, run, manifest)["needFiles"] == ["a.pdf"]
    folders.save_original(owned, current, run, "a.pdf", sha, content)
    assert folders.apply_manifest(owned, current, run, manifest)["needFiles"] == []
    folders.finish_transfer(owned, current, run)
    assert finish(owned, task["id"], connector)["completed"] == 1
    folders.control_task(owned, task["id"], ACTOR, "delete", connector)
    with pytest.raises(HTTPException):
        folders.connector_actor(store.db, paired["token"], connector)
    assert store.records("version")  # deleting automation is never document deletion


@pytest.mark.parametrize(
    "path",
    [
        "../escape.pdf",
        "/etc/secret.pdf",
        "x/../../secret.pdf",
        "C:\\data\\secret.pdf",
        "a//b.pdf",
        "a\x00.pdf",
    ],
)
def test_connector_rejects_escaping_manifest_paths(environment, path):
    store, _, connector, _, _, _, _, _ = environment
    task = folders.create_task(store, ACTOR, config("local"), connector)
    run = store.get(folders.RUN, folders.runs_for(store, task["id"])[0]["id"])
    with pytest.raises(HTTPException):
        folders.apply_manifest(
            store, task, run, [{"relativePath": path, "size": 10, "mtime": 0, "sha256": "a" * 64}]
        )
    assert store.records(folders.ITEM) == []


def test_server_root_symlink_escape_and_incomplete_scan_do_not_mark_missing(environment, tmp_path):
    store, source, connector, _, _, _, _, put = environment
    put("a.pdf", pdf_bytes())
    task = folders.create_task(store, ACTOR, config(maxFilesPerScan=1), connector)
    assert finish(store, task["id"], connector)["completed"] == 1
    outside = tmp_path / "private.pdf"
    outside.write_bytes(pdf_bytes(99))
    (source / "link.pdf").symlink_to(outside)
    with pytest.raises(ValueError):
        folders.safe_read(source, "link.pdf", 1000000)
    with pytest.raises(HTTPException):
        folders.probe(config(path="../"))
    put("b.pdf", pdf_bytes(2))
    folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    second = finish(store, task["id"], connector)
    assert second["truncated"] and second["new"] == 1
    assert not any(f.get("sourceMissing") for f in store.records(folders.FILE))


def test_directory_selection_and_reads_use_the_root_device(environment, monkeypatch):
    _, source, _, _, _, _, _, put = environment
    put("other-volume/paper.pdf", pdf_bytes())
    mounted_inode = (source / "other-volume").stat().st_ino
    real_fstat = os.fstat

    def mounted_device(fd):
        value = real_fstat(fd)
        if value.st_ino == mounted_inode:
            return SimpleNamespace(st_dev=value.st_dev + 1)
        return value

    monkeypatch.setattr(os, "fstat", mounted_device)
    with pytest.raises(HTTPException) as browse_error:
        folders.list_directories("mounted", "other-volume")
    assert browse_error.value.status_code == 409
    with pytest.raises(HTTPException) as save_error:
        folders.normalize_config(config(path="other-volume"))
    assert save_error.value.status_code == 409
    with pytest.raises(ValueError):
        folders.safe_read(source, "other-volume/paper.pdf", 1000000)


def test_scanning_subfolder_keeps_its_open_directory_when_renamed(environment):
    _, source, _, _, _, _, _, put = environment
    original = pdf_bytes(1)
    put("selected/paper.pdf", original)
    with folders._server_directory(config(path="selected")) as directory:
        (source / "selected").rename(source / "previous")
        put("selected/paper.pdf", pdf_bytes(2))
        content, _ = folders.safe_read(directory, "paper.pdf", 1000000)
    assert content == original


def test_schedule_timezone_weekly_and_same_task_no_overlap(environment):
    store, _, connector, _, _, _, _, _ = environment
    now = datetime(2026, 11, 17, 0, 1, tzinfo=UTC).timestamp()
    assert (
        folders.next_scan(
            {"frequency": "daily", "time": "08:00", "timezone": "Asia/Shanghai", "weekday": 0}, now
        )
        == "2026-11-18T00:00:00+00:00"
    )
    assert (
        folders.next_scan(
            {"frequency": "weekly", "time": "08:00", "timezone": "Asia/Shanghai", "weekday": 0}, now
        )
        == "2026-11-23T00:00:00+00:00"
    )
    task = folders.create_task(store, ACTOR, config(), connector)
    first = folders.runs_for(store, task["id"])[0]
    run, reused = folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    assert reused and run["id"] == first["id"] and len(folders.runs_for(store, task["id"])) == 1
    other = Store(store.db, "another-tenant")
    with pytest.raises(HTTPException):
        folders._task(other, task["id"])


def test_pause_during_scan_does_not_get_overwritten_by_scan_callback(environment, monkeypatch):
    store, _, connector, _, _, _, _, put = environment
    put("a.pdf", pdf_bytes())
    task = folders.create_task(store, ACTOR, config(), connector)
    original_scan = folders.scan_server

    def scan_then_pause(config, heartbeat=None):
        result = original_scan(config, heartbeat)
        folders.control_task(store, task["id"], ACTOR, "pause", connector)
        return result

    monkeypatch.setattr(folders, "scan_server", scan_then_pause)
    run_id = folders.runs_for(store, task["id"])[0]["id"]
    assert not folders.process_run(store, run_id, connector)
    assert store.get(folders.TASK, task["id"])["paused"]
    assert not store.get(folders.RUN, run_id)["manifestReceived"]


def test_delete_during_archive_never_revives_cancelled_run(environment):
    store, _, connector, _, _, _, _, put = environment
    put("a.pdf", pdf_bytes())
    task = folders.create_task(store, ACTOR, config(), connector)
    run_id = folders.runs_for(store, task["id"])[0]["id"]
    assert folders.process_run(store, run_id, connector)  # scan
    assert folders.process_run(store, run_id, connector)  # save original

    def archive_then_delete(operation, subject, **values):
        result = connector(operation, subject, **values)
        if operation == "folderImportPaper":
            folders.control_task(store, task["id"], ACTOR, "delete", connector)
        return result

    assert folders.process_run(store, run_id, archive_then_delete)
    assert store.get(folders.RUN, run_id)["status"] == "cancelled"
    assert store.get(folders.TASK, task["id"])["deletedAt"]
    assert folders.items_for(store, run_id)[0]["originalSaved"]
    assert folders.items_for(store, run_id)[0]["paperId"]


def test_target_change_during_scan_only_applies_to_later_runs(environment, monkeypatch):
    store, _, connector, calls, state, _, _, put = environment
    second_folder = "22222222-2222-4222-8222-222222222222"
    state["folders"].append({"id": second_folder, "name": "新目标"})
    put("a.pdf", pdf_bytes())
    task = folders.create_task(store, ACTOR, config(), connector)
    original_scan = folders.scan_server

    def scan_then_reconfigure(config_value, heartbeat=None):
        result = original_scan(config_value, heartbeat)
        folders.update_task(store, task["id"], ACTOR, config(folderId=second_folder), connector)
        return result

    monkeypatch.setattr(folders, "scan_server", scan_then_reconfigure)
    first = finish(store, task["id"], connector)
    assert first["completed"] == 1 and first["folderId"] == FOLDER
    assert store.get(folders.TASK, task["id"])["folderId"] == second_folder
    assert all(c[2]["folderId"] == FOLDER for c in calls if c[0] == "folderImportPaper")


def test_network_retries_are_bounded_and_resume_saved_phase_without_reupload(environment):
    store, _, connector, _, _, _, _, put = environment
    put("a.pdf", pdf_bytes())
    task = folders.create_task(store, ACTOR, config(), connector)
    run_id = folders.runs_for(store, task["id"])[0]["id"]
    folders.process_run(store, run_id, connector)
    folders.process_run(store, run_id, connector)

    def offline(operation, subject, **values):
        if operation == "folderImportPaper":
            raise bridge.BridgeError(503, "服务暂不可用")
        return connector(operation, subject, **values)

    for _ in range(3):
        item = folders.items_for(store, run_id)[0]
        item["nextAttemptAt"] = 0
        store.put(folders.ITEM, item)
        store.db.commit()
        folders.process_run(store, run_id, offline)
    run = store.get(folders.RUN, run_id)
    assert run["status"] == "failed"
    item = folders.items_for(store, run_id)[0]
    assert item["originalSaved"] and item["attempts"] == 3
    version_count = len(store.records("version"))
    folders.retry_run(store, run_id, ACTOR, connector)
    assert finish(store, task["id"], connector)["completed"] == 1
    assert len(store.records("version")) == version_count


def test_deleted_content_is_not_auto_restored_through_new_filename(environment):
    store, source, connector, _, _, _, deleted, put = environment
    content = pdf_bytes()
    put("a.pdf", content)
    task = folders.create_task(store, ACTOR, config(), connector)
    finish(store, task["id"], connector)
    deleted.add(hashlib.sha256(content).hexdigest())
    (source / "a.pdf").rename(source / "renamed.pdf")
    folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    second = finish(store, task["id"], connector)
    assert second["completed"] == 0
    ignored = folders.items_for(store, second["id"])[0]
    assert ignored["status"] == "ignored" and ignored["suppressed"]
    count = len(store.records("version"))
    folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    third = finish(store, task["id"], connector)
    assert folders.items_for(store, third["id"])[0]["status"] == "ignored"
    assert len(store.records("version")) == count


def test_transport_hash_mismatch_leaves_file_retryable(environment):
    store, _, connector, _, _, _, _, _ = environment
    task = folders.create_task(store, ACTOR, config("local"), connector)
    run = store.get(folders.RUN, folders.runs_for(store, task["id"])[0]["id"])
    content = pdf_bytes()
    sha = hashlib.sha256(content).hexdigest()
    folders.apply_manifest(
        store,
        task,
        run,
        [{"relativePath": "a.pdf", "sha256": sha, "mtime": 0, "size": len(content)}],
    )
    with pytest.raises(HTTPException) as exc:
        folders.save_original(store, task, run, "a.pdf", sha, content[:-1] + b"x")
    assert exc.value.status_code == 409
    assert not folders.items_for(store, run["id"])[0]["originalSaved"]
    assert folders.save_original(store, task, run, "a.pdf", sha, content)["saved"]


def test_server_retry_can_recheck_previously_unreadable_file_and_recovery_catches_up_once(
    environment,
):
    store, source, connector, _, _, _, _, put = environment
    path = source / "pending.pdf"
    path.write_bytes(b"")
    os.utime(path, (time.time() - 10, time.time() - 10))
    task = folders.create_task(store, ACTOR, config(), connector)
    first = finish(store, task["id"], connector)
    assert first["failed"] == 1
    put("pending.pdf", pdf_bytes(7))
    folders.retry_run(store, first["id"], ACTOR, connector)
    recovered = finish(store, task["id"], connector)
    assert recovered["completed"] == 1 and recovered["failed"] == 0
    current = store.get(folders.TASK, task["id"])
    current["nextScanAt"] = "2020-01-01T00:00:00+00:00"
    store.put(folders.TASK, current)
    store.db.commit()
    folders.schedule_due(store.db, connector=connector)
    assert len(folders.runs_for(store, task["id"])) == 2
    # A second expired trigger reuses the existing batch and moves the next slot ahead.
    current = store.get(folders.TASK, task["id"])
    current["nextScanAt"] = "2020-01-01T00:00:00+00:00"
    store.put(folders.TASK, current)
    store.db.commit()
    folders.schedule_due(store.db, connector=connector)
    assert len(folders.runs_for(store, task["id"])) == 2
    assert (
        datetime.fromisoformat(store.get(folders.TASK, task["id"])["nextScanAt"]).timestamp()
        > time.time()
    )


def test_daily_allowance_holds_same_batch_and_resumes_after_timezone_midnight(
    environment, monkeypatch
):
    store, _, connector, _, _, _, _, put = environment
    contents = [pdf_bytes(n) for n in range(3)]
    for n, content in enumerate(contents):
        put(f"paper-{n}.pdf", content)
    clock = [time.time()]
    monkeypatch.setattr(folders.time, "time", lambda: clock[0])
    task = folders.create_task(store, ACTOR, config(dailyFileLimit=2), connector)
    run_id = folders.runs_for(store, task["id"])[0]["id"]
    for _ in range(100):
        folders.process_run(store, run_id, connector)
        if store.get(folders.RUN, run_id)["status"] == "waiting_quota":
            break
    run = store.get(folders.RUN, run_id)
    saved_task = store.get(folders.TASK, task["id"])
    assert run["status"] == "waiting_quota" and run["completed"] == 2
    assert not saved_task["paused"] and saved_task["lastError"] == folders.QUOTA_MESSAGE
    shown = folders.public_task(store, saved_task)
    assert shown["status"] == "waiting_quota" and shown["usage"]["remainingFiles"] == 0
    assert shown["usage"]["completedFiles"] == shown["usage"]["indexedFiles"] == 2
    assert shown["usage"]["parsedPages"] == 2
    assert shown["usage"]["originalBytes"] == len(contents[0]) + len(contents[1])
    assert (
        datetime.fromisoformat(run["nextRetryAt"])
        .astimezone(folders.ZoneInfo("Asia/Shanghai"))
        .hour
        == 0
    )
    result, reused = folders.queue_scan(store, task["id"], ACTOR["subject"], connector=connector)
    assert reused and result["id"] == run_id
    count = len(store.records(folders.METER))
    assert not folders.process_run(store, run_id, connector)
    assert len(store.records(folders.METER)) == count
    clock[0] = datetime.fromisoformat(run["nextRetryAt"]).timestamp() + 1
    # Reconstructing service state reads the persisted quota and continues its original queue.
    resumed = Store(store.db, ACTOR["tenant"])
    result = finish(resumed, task["id"], connector)
    assert result["id"] == run_id and result["completed"] == 3 and result["status"] == "completed"
    usage = folders.public_task(resumed, resumed.get(folders.TASK, task["id"]))["usage"]
    assert usage["completedFiles"] == usage["indexedFiles"] == usage["parsedPages"] == 1
    assert usage["originalBytes"] == len(contents[2])
    assert len(resumed.records(folders.USAGE)) == 2
    assert sum(day["completedFiles"] for day in resumed.records(folders.USAGE)) == 3


def test_increasing_daily_limit_releases_wait_without_rebuilding_or_reprocessing(environment):
    store, _, connector, calls, _, _, _, put = environment
    for n in range(2):
        put(f"paper-{n}.pdf", pdf_bytes(n))
    task = folders.create_task(store, ACTOR, config(dailyFileLimit=1), connector)
    run_id = folders.runs_for(store, task["id"])[0]["id"]
    for _ in range(80):
        folders.process_run(store, run_id, connector)
        if store.get(folders.RUN, run_id)["status"] == "waiting_quota":
            break
    completed = next(i for i in folders.items_for(store, run_id) if i["status"] == "completed")
    folders.update_task(store, task["id"], ACTOR, config(dailyFileLimit=2), connector)
    assert finish(store, task["id"], connector)["completed"] == 2
    assert len(folders.runs_for(store, task["id"])) == 1
    assert (
        len(
            [
                c
                for c in calls
                if c[0] == "indexFolderPaper" and c[2]["sha256"] == completed["sha256"]
            ]
        )
        == 1
    )
    assert folders.public_task(store, store.get(folders.TASK, task["id"]))["lastError"] is None


def test_usage_is_durable_and_shared_content_avoids_original_and_parse_recounts(environment):
    store, _, connector, _, _, _, _, put = environment
    content = pdf_bytes(7)
    put("a.pdf", content)
    first = folders.create_task(store, ACTOR, config(), connector)
    assert finish(store, first["id"], connector)["completed"] == 1
    one = folders.public_task(store, store.get(folders.TASK, first["id"]))["usage"]
    assert one["originalBytes"] == len(content) and one["parsedPages"] == 1
    assert one["parsedCharacters"] > 80 and one["unknownParsedPages"] == 0
    assert one["indexMeasurement"] == "confirmed-files"
    second = folders.create_task(store, ACTOR, config(name="重复资料"), connector)
    assert finish(store, second["id"], connector)["completed"] == 1
    two = folders.public_task(store, store.get(folders.TASK, second["id"]))["usage"]
    assert two["completedFiles"] == two["indexedFiles"] == two["reusedFiles"] == 1
    assert two["originalBytes"] == two["parsedPages"] == two["parsedCharacters"] == 0
    count = len(store.records(folders.METER))
    folders.queue_scan(store, first["id"], ACTOR["subject"], connector=connector)
    assert finish(store, first["id"], connector)["unchanged"] == 1
    assert len(store.records(folders.METER)) == count


def test_quota_boundaries_reject_invalid_values_and_leave_existing_data(environment):
    store, _, connector, _, _, _, _, _ = environment
    for limit in (0, 50001, -1, True):
        with pytest.raises(HTTPException) as exc:
            folders.create_task(store, ACTOR, config(dailyFileLimit=limit), connector)
        assert exc.value.status_code == 422
    assert store.records(folders.TASK) == []
