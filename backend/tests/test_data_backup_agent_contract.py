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


def test_daily_plan_update_over_signed_http_with_synthetic_crontab(monkeypatch):
    from types import SimpleNamespace

    from app.schemas.data_backup import PlanInput

    fixture = fixture_module.Fixture()
    fixture.setUp()
    server = worker = None
    try:
        fixture.cfg["allowPlanChanges"] = True
        original = f"CRON_TZ=Asia/Shanghai\n17 2 * * * /usr/bin/python3 {fixture.cfg['planScript']} --key /private/key\n*/5 * * * * /usr/bin/health-check\n"
        cron = {"text": original}

        def command(args, **kwargs):
            assert args in (["crontab", "-l"], ["crontab", "-"])
            if args[-1] == "-":
                cron["text"] = kwargs["input"]
            return SimpleNamespace(stdout=cron["text"] if args[-1] == "-l" else "", stderr="", returncode=0)

        monkeypatch.setattr(fixture_module.a.subprocess, "run", command)
        monkeypatch.setattr(fixture_module.a, "timezone_read", lambda: "UTC")
        server = fixture_module.a.Server(("127.0.0.1", 0), fixture.app)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_URL", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setattr(settings, "DATA_BACKUP_AGENT_SECRET", fixture.cfg["secret"].decode())
        plan = data_backup.snapshot()["plan"]
        assert plan["editable"] is True and plan["dailyTime"] == "02:17"
        body = PlanInput(daily_time="04:23", enabled=True, revision=plan["revision"])
        saved = data_backup.update_plan(body, "synthetic-admin")
        assert saved["dailyTime"] == "04:23" and saved["nextRunAt"] is not None
        assert cron["text"] == original.replace("17 2 * * *", "23 4 * * *")
        with pytest.raises(HTTPException) as stale:
            data_backup.update_plan(body, "synthetic-admin")
        assert stale.value.status_code == 409 and stale.value.detail["code"] == "plan_changed"
        saved = data_backup.update_plan(PlanInput(daily_time="04:23", enabled=False, revision=saved["revision"]), "synthetic-admin")
        assert saved["status"] == "disabled" and saved["nextRunAt"] is None
        assert "private" not in str(saved)
        with fixture.app.store.connect() as db:
            rows = db.execute("SELECT actor,status FROM plan_changes").fetchall()
        assert len(rows) == 2 and all(row["actor"] == "synthetic-admin" and row["status"] == "succeeded" for row in rows)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if worker is not None:
            worker.join(timeout=5)
        fixture.tearDown()
