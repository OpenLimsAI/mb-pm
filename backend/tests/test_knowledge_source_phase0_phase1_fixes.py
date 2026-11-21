# ruff: noqa: F401, F811
"""Regression coverage for Knowledge Sources Phase 0 & Phase 1 security, reliability & perf fixes."""

import asyncio
import base64
import hashlib
import importlib.util
import io
import time
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from app.api.v1.knowledge_source_library_v3 import MetadataInput
from app.core.config import settings
from app.middleware.request_limits import RequestLimitsMiddleware
from app.services import folder_imports as folders
from app.services import iam_admin, knowledge_source_worker
from app.services import knowledge_source_manual_index_v3 as manual_index
from app.services import knowledge_source_original_delete as original_delete
from app.services.information import bridge, worker
from app.services.knowledge_source_exports_v3 import LIMIT, export_selection
from app.services.knowledge_source_status import public_jobs
from fastapi import HTTPException
from test_folder_imports import ACTOR, config, environment, finish, pdf_bytes
from test_information_api import live
from test_information_live import catalogue, store
from test_information_portal import information_portal
from test_knowledge_sources import F1, headers, ks, records, saved_document


def _load_module(name: str, rel_path: str):
    path = Path(__file__).resolve().parents[2] / rel_path
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_p0_01_and_02_non_kb_portal_users_blocked_across_ks_and_retired_original(ks, monkeypatch):
    client, db, session, role, state, _ = ks
    _, _, doc, version = saved_document(db, linked=True)
    # Employee with no KB role (e.g. plain PM staff) must get 403 on all KS & retired original endpoints.
    role["value"] = "rd"
    for endpoint in (
        "/api/v1/knowledge-sources/snapshot",
        "/api/v1/knowledge-sources/snapshot?summary=true",
        "/api/v1/knowledge-sources/jobs/status",
        "/api/v1/knowledge-sources/v3/digest",
        "/api/v1/knowledge-sources/v3/watches",
        "/api/v1/knowledge-sources/v3/templates",
        f'/api/v1/knowledge-sources/documents/{doc["id"]}/versions/{version["id"]}/original',
        f'/api/v1/information/documents/{doc["id"]}/versions/{version["id"]}/original',
        "/api/v1/knowledge-sources/v3/folder-imports/connector/script",
    ):
        res = client.get(endpoint, headers=session())
        assert res.status_code == 403, f"{endpoint} leaked status {res.status_code}"

    # Even if IAM grants kb_viewer, if DIKW revokes access (403), /snapshot must not leak local records.
    role["value"] = "kb_viewer"
    monkeypatch.setattr(
        bridge,
        "call",
        lambda *a, **kw: (_ for _ in ()).throw(bridge.BridgeError(403, "知识库权限已撤销")),
    )
    snap = client.get("/api/v1/knowledge-sources/snapshot", headers=session()).json()
    assert snap["documents"] == []
    assert snap["sources"] == []
    assert snap["jobs"] == []
    assert snap["changes"] == []
    assert snap["resources"]["originalFiles"] == 0

    # Deleted KB paper cannot be read via retired /information/.../original either.
    state["papers"] = []
    monkeypatch.setattr(bridge, "call", lambda op, sub, **kw: state)
    res_deleted = client.get(
        f'/api/v1/information/documents/{doc["id"]}/versions/{version["id"]}/original',
        headers=session(),
    )
    assert res_deleted.status_code == 404


def test_p0_02_public_jobs_redacts_other_users_private_rule_ids(store):
    s, _ = store
    src = s.ensure_source()
    s.put("document", {"id": "d1", "sourceId": src["id"], "title": "Doc 1", "scopes": ["Q"]})
    job = s.create_job(
        src["id"], "alice", app="knowledge-sources", kind="import", document_ids=["d1"]
    )
    job["ruleFiling"] = {
        "status": "completed",
        "undoTokens": [],
        "results": [{"ruleId": "alice-secret-rule", "saved": True, "count": 1}],
    }
    s.put("job", job)
    s.db.commit()
    bob_view = public_jobs(s, "bob")
    assert "ruleId" not in bob_view[0]["ruleFiling"]["results"][0]
    alice_view = public_jobs(s, "alice")
    assert alice_view[0]["ruleFiling"]["results"][0]["ruleId"] == "alice-secret-rule"


def test_p0_03_and_sec_03_connector_windows_unicode_quotes_and_crlf_paths(tmp_path):
    connector = _load_module("ks_connector_mod", "scripts/knowledge-folder-connector.py")
    for bad in ("bad\rname.pdf", "bad\nname.pdf", "dir/bad\x07.pdf"):
        with pytest.raises(connector.ConnectorError):
            connector.relative_path(bad)

    tricky_cfg = tmp_path / "O’Brien‘$(calc)’" / "config.json"
    tricky_cfg.parent.mkdir(parents=True)
    tricky_cfg.write_text("{}")
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env", {})

        class Result:
            returncode = 0

        return Result()

    with (
        patch.object(connector.sys, "platform", "win32"),
        patch.dict(connector.os.environ, {"APPDATA": str(tmp_path)}, clear=False),
        patch.object(connector.subprocess, "run", side_effect=fake_run),
    ):
        connector.startup(tricky_cfg)

    ps_script = captured["cmd"][-1]
    assert "O’Brien" not in ps_script
    assert "calc" not in ps_script
    assert "$env:MBERP_SHORTCUT_DEST" in ps_script
    assert "O’Brien" in captured["env"]["MBERP_SHORTCUT_ARGS"]


def test_p0_04_export_zip_blocks_zip_bomb_and_windows_zip_slip(store, monkeypatch):
    import app.services.knowledge_source_exports_v3 as exports_mod

    s, _ = store
    monkeypatch.setattr(exports_mod, "LIMIT", 1024)

    def make_zip(filename: str, payload: bytes) -> str:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(filename, payload)
        return base64.b64encode(buf.getvalue()).decode()

    for bad_zip in (
        make_zip("..\\..\\evil.pdf", b"%PDF-1.4"),
        make_zip("C:evil.pdf", b"%PDF-1.4"),
        make_zip("bomb.pdf", b"0" * 4096),  # compresses tiny, decompresses > 1024 LIMIT
    ):

        def fake_connect(op, sub, payload=bad_zip, **kw):
            if op == "librarySummary":
                return {"canWrite": True}
            return {"base64": payload, "contentType": "application/zip"}

        with pytest.raises(HTTPException) as exc:
            export_selection(s, {"subject": "alice"}, ["sources/a.md"], "zip", fake_connect)
        assert exc.value.status_code == 502


def test_p0_05_worker_overlay_propagates_folder_import_env():
    overlay = _load_module("worker_overlay_mod", "deploy/parallel-test/worker_overlay.py")
    assert any("KNOWLEDGE_FOLDER_IMPORT_ROOTS".startswith(p) for p in overlay.WORKER_ENV_PREFIXES)
    assert any(
        "KNOWLEDGE_FOLDER_IMPORT_MAX_FILE_MB".startswith(p) for p in overlay.WORKER_ENV_PREFIXES
    )


def test_p0_06_request_limits_allows_100mb_connector_upload_and_skips_zero_body(monkeypatch):
    monkeypatch.setattr(settings, "KNOWLEDGE_FOLDER_IMPORT_MAX_FILE_MB", 100)
    seen = []

    async def ok_app(scope, receive, send):
        msg = await receive()
        seen.append(len(msg.get("body", b"")))
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = RequestLimitsMiddleware(ok_app)

    async def call(path: str, content_length: int):
        statuses = []
        scope = {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": [(b"content-length", str(content_length).encode())],
        }

        async def receive():
            return {"type": "http.request", "body": b"x", "more_body": False}

        async def send(msg):
            if msg["type"] == "http.response.start":
                statuses.append(msg["status"])

        await mw(scope, receive, send)
        return statuses[0]

    # 50 MiB rejected on regular API route, accepted on folder connector file upload route.
    fifty_mb = 50 * 1024 * 1024
    assert asyncio.run(call("/api/v1/knowledge-sources/v3/upload", fifty_mb)) == 413
    assert (
        asyncio.run(
            call(
                "/api/v1/knowledge-sources/v3/folder-imports/connector/runs/r1/files",
                fifty_mb,
            )
        )
        == 200
    )


def test_p0_07_and_08_manual_index_timeout_and_transient_503_does_not_pause(
    environment, monkeypatch
):
    store_fi, _, connector, calls, _, _, _, put = environment
    put("doc.pdf", pdf_bytes(3))
    task = folders.create_task(store_fi, ACTOR, config("local"), connector)
    run_id = folders.runs_for(store_fi, task["id"])[0]["id"]
    calls.clear()

    # Idle local run awaiting manifest must NOT call DIKW/IAM every 2s tick.
    assert folders.process_run(store_fi, run_id, connector) is False
    assert calls == []

    # Invalid error path in manifest must record as failed item rather than 422-aborting batch.
    run = store_fi.get(folders.RUN, run_id)
    folders.apply_manifest(
        store_fi,
        task,
        run,
        [],
        errors=[{"relativePath": "C:\\bad:name.pdf", "error": "unreadable"}],
    )
    items = folders.items_for(store_fi, run_id)
    assert len(items) == 1 and items[0]["status"] == "failed"

    # Transient 503 during schedule_due must back off nextScanAt, NOT pause the task permanently!
    server_task = folders.create_task(
        store_fi,
        ACTOR,
        config("server"),
        connector,
    )
    stored = store_fi.get(folders.TASK, server_task["id"])
    stored["nextScanAt"] = "2020-01-01T00:00:00+00:00"
    store_fi.put(folders.TASK, stored)
    store_fi.db.commit()

    def transient_503(*args, **kwargs):
        raise HTTPException(503, "IAM 暂时不可用")

    folders.schedule_due(store_fi.db, now=time.time(), connector=transient_503)
    after_503 = store_fi.get(folders.TASK, server_task["id"])
    assert after_503["paused"] is False
    assert after_503["nextScanAt"] is not None

    # Deterministic 403 MUST pause the task.
    stored = store_fi.get(folders.TASK, server_task["id"])
    stored["nextScanAt"] = "2020-01-01T00:00:00+00:00"
    store_fi.put(folders.TASK, stored)
    store_fi.db.commit()
    folders.schedule_due(
        store_fi.db,
        now=time.time(),
        connector=lambda *a, **kw: (_ for _ in ()).throw(HTTPException(403, "权限已撤销")),
    )
    after_403 = store_fi.get(folders.TASK, server_task["id"])
    assert after_403["paused"] is True and after_403["nextScanAt"] is None


def test_p0_10_discard_manual_files_retains_shared_pdf_through_symlinked_root(tmp_path):
    try:
        folder_core = _load_module(
            "folder_core_mod", "extensions/knowledge-folder-core/folder_core.py"
        )
    except ModuleNotFoundError:
        pytest.skip("dikw_core not installed in PM backend venv")
    real_root = tmp_path / "real_kb"
    (real_root / "sources").mkdir(parents=True)
    (real_root / "knowledge").mkdir(parents=True)
    (real_root / "wisdom").mkdir(parents=True)
    symlink_root = tmp_path / "linked_kb"
    symlink_root.symlink_to(real_root, target_is_directory=True)

    pdf_data = b"%PDF-1.7 shared content"
    pdf_sha = hashlib.sha256(pdf_data).hexdigest()
    md_rel = f"sources/upload-{pdf_sha[:21]}.md"
    md_bytes = (
        f'---\nsource_kind: "manual-upload"\noriginal_sha256: "{pdf_sha}"\n---\nbody'.encode()
    )
    md_sha = hashlib.sha256(md_bytes).hexdigest()
    (real_root / md_rel).write_bytes(md_bytes)
    (real_root / "sources" / f"{pdf_sha}.pdf").write_bytes(pdf_data)
    (real_root / "knowledge" / "summary.md").write_text(f"See ({pdf_sha}.pdf) for details.")

    upload = folder_core.ManualOriginal(sha256=pdf_sha, sourceHash=md_sha, path=md_rel)
    res = folder_core.discard_manual_files(symlink_root, upload)
    assert res == {"discarded": True, "sharedOriginalRetained": True}
    assert (real_root / "sources" / f"{pdf_sha}.pdf").is_file()


def test_phase1_metadata_validation_ssrf_and_probe_lightweight(ks, environment, monkeypatch):
    # MetadataInput rejects nested dicts
    with pytest.raises(ValueError):
        MetadataInput(paperId="sources/a.md", revision=0, metadata={"nested": {"bad": 1}})

    # create_source rejects loopback/private IPs and non-443 ports
    client, _, session, role, _, _ = ks
    role["value"] = "kb_manager"
    for bad_url in (
        "https://127.0.0.1/feed",
        "https://10.0.0.8/feed",
        "https://localhost/feed",
        "https://ich.org:8443/custom",
    ):
        res = client.post(
            "/api/v1/knowledge-sources/sources",
            headers=headers(session),
            json={"name": "Bad", "url": bad_url},
        )
        assert res.status_code == 400, bad_url

    # Single-upload optimization: healthy server folder import calls folderImportPaper ONCE (not twice)
    store_fi, _, connector, calls, _, _, _, put = environment
    put("single_upload.pdf", pdf_bytes(42))
    task = folders.create_task(store_fi, ACTOR, config("server"), connector)
    run = finish(store_fi, task["id"], connector)
    assert run["status"] == "completed" and run["completed"] == 1
    import_calls = [c for c in calls if c[0] == "folderImportPaper"]
    assert len(import_calls) == 1
    assert import_calls[0][2]["text"]  # uploaded once with extracted text already attached


def test_phase1_original_delete_retains_pdf_when_db_commit_fails(store, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "INFORMATION_DATA_DIR", str(tmp_path))
    s, _ = store
    source_id = s.key("source", "manual-upload")
    s.put("source", {"id": source_id, "adapter": "manual", "name": "手动收录"})
    doc_id = s.key("document", "manual:test")
    s.put(
        "document",
        {"id": doc_id, "sourceId": source_id, "title": "Manual Doc", "documentType": "手动上传"},
    )
    version = s.archive(doc_id, b"%PDF-1.7-keep-on-rollback", "text", parse_status="ready")
    version.update(
        kbPath="sources/upload-test.md", kbDocumentId="kb-doc-1", indexStatus="not_requested"
    )
    s.put("version", version)
    s.db.commit()

    paper_id = "archive:" + version["id"]
    pdf_path = s.archive_path(version)
    assert pdf_path.is_file()

    def connect(op, sub, **kw):
        return {"path": "sources/upload-test.md", "discarded": True}

    plan = original_delete.preview(s, "alice", paper_id, connect)

    def boom():
        raise RuntimeError("simulated DB commit failure")

    monkeypatch.setattr(s.db, "commit", boom)
    with pytest.raises(RuntimeError):
        original_delete.confirm(s, "alice", paper_id, plan["planId"], connect)
    # Physical PDF must NOT have been unlinked before the failed commit!
    assert pdf_path.is_file()
