"""Real loopback HMAC transport against the host catalogue, with synthetic files only."""

import importlib.util
import threading
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.schemas.data_backup import DeletePreviewInput, DeletionInput
from app.services import data_backup

SPEC = importlib.util.spec_from_file_location(
    "synthetic_catalogue_fixture",
    Path(__file__).parents[2] / "deploy/data-backup/tests/test_catalogue_agent.py",
)
fixture_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture_module)


def test_signed_snapshot_preview_and_idempotent_deletion_over_real_http(monkeypatch):
    fixture = fixture_module.Fixture()
    fixture.setUp()
    server = None
    worker = None
    try:
        old, newest = fixture.pair()
        monkeypatch.setattr(
            fixture_module.a,
            "plan_read",
            lambda _: {
                "status": "active",
                "source": "cron",
                "timezone": "Asia/Shanghai",
                "summary": "合成测试计划",
                "retentionSummary": "保留14天和14份",
                "checkedAt": None,
            },
        )
        server = fixture_module.a.Server(("127.0.0.1", 0), fixture.app)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        monkeypatch.setattr(
            settings, "DATA_BACKUP_AGENT_URL", f"http://127.0.0.1:{server.server_port}"
        )
        monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_SECRET", fixture.cfg["secret"].decode())
        snapshot = data_backup.snapshot()
        assert snapshot["plan"]["source"] == "cron"
        assert len(snapshot["archives"]) == 3
        selected = next(item for item in snapshot["archives"] if item["name"] == old.name)
        assert selected["protected"] is False
        preview = data_backup.delete_preview(
            DeletePreviewInput(
                archive_ids=[selected["id"]], catalog_revision=snapshot["catalogRevision"]
            ),
            "synthetic-admin",
        )
        assert preview["items"][0]["id"] == selected["id"]
        assert preview["itemCount"] == 1
        body = DeletionInput(
            token=preview["token"], confirmation="删除 1 份备份", request_id=uuid4()
        )
        with pytest.raises(HTTPException) as wrong_actor:
            data_backup.delete_archives(body, "different-admin")
        assert wrong_actor.value.status_code == 409
        assert wrong_actor.value.detail["code"] == "expired_request"
        receipt = data_backup.delete_archives(body, "synthetic-admin")
        assert receipt["status"] == "succeeded" and receipt["deletedCount"] == 1
        assert receipt["actor"] == "synthetic-admin"
        assert not old.exists() and newest.exists()
        assert data_backup.delete_archives(body, "synthetic-admin") == receipt
        refreshed = data_backup.snapshot()
        assert refreshed["catalogRevision"] != snapshot["catalogRevision"]
        assert refreshed["deletions"][0] == receipt
        assert all(item["protected"] for item in refreshed["archives"])
        with pytest.raises(HTTPException) as protected:
            data_backup.delete_preview(
                DeletePreviewInput(
                    archive_ids=[refreshed["archives"][0]["id"]],
                    catalog_revision=refreshed["catalogRevision"],
                ),
                "synthetic-admin",
            )
        assert protected.value.status_code == 409
        assert protected.value.detail["code"] == "protected"
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if worker is not None:
            worker.join(timeout=5)
        fixture.tearDown()
