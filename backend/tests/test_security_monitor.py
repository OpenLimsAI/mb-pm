"""Monitor behavior against synthetic Docker replies; never invokes Docker."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location(
    "security_monitor",
    Path(__file__).resolve().parents[2] / "deploy/security/monitor.py",
)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def container(name="known"):
    return {
        "Name": "/" + name,
        "Config": {"Env": ["APP_SECRET=synthetic-private-value"]},
        "State": {"Running": True, "Status": "running", "Health": {"Status": "healthy"}},
        "HostConfig": {
            "Memory": 256 * 1024**2,
            "MemorySwap": 256 * 1024**2,
            "PidsLimit": 10,
            "NanoCpus": 1_000_000_000,
            "LogConfig": {"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}},
        },
    }


@pytest.fixture
def run_monitor(monkeypatch, tmp_path):
    monkeypatch.setattr(monitor, "LIMITS", {"known": (256, 10, 1)})
    monkeypatch.setattr(monitor.os, "umask", lambda value: None)
    monkeypatch.setattr(
        monitor.shutil, "disk_usage",
        lambda path: SimpleNamespace(total=100 * 1024**3, used=20 * 1024**3, free=80 * 1024**3),
    )
    output = tmp_path / "report.json"
    backups = tmp_path / "backups"
    backups.mkdir()
    (backups / "maibo-fresh.tar.gz.gpg").write_bytes(b"synthetic encrypted archive")

    def run(items, *, expected=None, failure=False, apply=False):
        if expected:
            monkeypatch.setattr(monitor, "LIMITS", {name: (256, 10, 1) for name in expected})
        calls = []

        def command(argv, **kwargs):
            calls.append(argv)
            if failure:
                raise subprocess.CalledProcessError(1, argv, stderr=b"synthetic-private-value")
            if argv[:2] == ["docker", "ps"]:
                assert "--all" in argv
                return "\n".join(item["Name"].lstrip("/") for item in items).encode()
            assert argv[:2] == ["docker", "inspect"]
            assert all(name in monitor.LIMITS for name in argv[2:])
            return json.dumps([item for item in items if item["Name"].lstrip("/") in argv[2:]]).encode()

        monkeypatch.setattr(monitor.sp, "check_output", command)
        monkeypatch.setattr(monitor.sp, "run", lambda argv, **kwargs: calls.append(argv))
        monkeypatch.setattr(sys, "argv", ["monitor", "--output", str(output), "--backup-directory", str(backups)] + (["--apply-limits"] if apply else []))
        with pytest.raises(SystemExit) as exited:
            monitor.main()
        return json.loads(output.read_text()), exited.value.code, calls

    return run, output, backups


def test_stopped_missing_and_candidates_cannot_look_healthy(run_monitor, capsys):
    run, output, _ = run_monitor
    stopped = container()
    stopped["State"].update(Running=False, Status="exited", Error="synthetic-private-value")
    report, code, calls = run([stopped, container("candidate")], expected=["known", "missing"], apply=True)
    assert code == 1
    assert "known:unhealthy" in report["alerts"]
    assert "missing:missing" in report["alerts"]
    assert report["containers"][0]["health"] == "exited"
    assert [call[-1] for call in calls if call[:2] == ["docker", "update"]] == ["known"]
    assert "synthetic-private-value" not in output.read_text() + capsys.readouterr().out


@pytest.mark.parametrize("field,value", [
    ("Memory", 0), ("Memory", 257 * 1024**2), ("MemorySwap", -1), ("MemorySwap", 0),
    ("PidsLimit", -1), ("PidsLimit", 11), ("NanoCpus", 0), ("NanoCpus", 2_000_000_000),
])
def test_resource_limits_require_memory_swap_pids_and_cpu(monkeypatch, field, value):
    monkeypatch.setattr(monitor, "LIMITS", {"known": (256, 10, 1)})
    config = container()["HostConfig"]
    config[field] = value
    assert not monitor.resource_limits(config, "known")


def test_cpu_quota_period_is_supported(monkeypatch):
    monkeypatch.setattr(monitor, "LIMITS", {"known": (256, 10, 1)})
    config = container()["HostConfig"]
    config.update(NanoCpus=0, CpuQuota=50_000, CpuPeriod=100_000)
    assert monitor.resource_limits(config, "known")


@pytest.mark.parametrize("driver,options,expected", [
    ("local", {}, True), ("json-file", {}, False),
    ("json-file", {"max-size": "10m"}, True),
    ("json-file", {"max-size": "-1", "max-file": "3"}, False),
    ("json-file", {"max-size": "10m", "max-file": "0"}, False),
    ("local", {"max-size": "0m"}, False),
    ("journald", {"max-size": "10m", "max-file": "3"}, False),
])
def test_logging_driver_and_positive_effective_limits(driver, options, expected):
    assert monitor.log_rotation({"Type": driver, "Config": options}) is expected


def test_daemon_failure_writes_fresh_safe_alert(run_monitor, capsys):
    run, output, _ = run_monitor
    report, code, _ = run([], failure=True)
    assert code == 1
    assert "docker_unavailable" in report["alerts"]
    assert "synthetic-private-value" not in output.read_text() + capsys.readouterr().out


def test_empty_managed_inventory_is_an_alert_not_a_success(run_monitor):
    run, _, _ = run_monitor
    report, code, calls = run([container("candidate")])
    assert code == 1
    assert "known:missing" in report["alerts"]
    assert not any(call[:2] == ["docker", "inspect"] for call in calls)


def test_backup_freshness_uses_mtime_and_report_replaces_insecure_file(run_monitor):
    run, output, backups = run_monitor
    old = backups / "maibo-z-last-name.tar.gz.gpg"
    old.write_bytes(b"old")
    os.utime(old, (time.time() - 48 * 3600,) * 2)
    output.write_text("old report")
    output.chmod(0o666)
    report, code, _ = run([container()])
    assert code == 0
    assert report["backup_age_hours"] < 1
    assert output.stat().st_mode & 0o777 == 0o600


def test_paused_and_oom_services_alert_even_with_old_healthy_status(run_monitor):
    run, _, _ = run_monitor
    for change in ({"Paused": True}, {"OOMKilled": True}):
        item = copy.deepcopy(container())
        item["State"].update(change)
        report, code, _ = run([item])
        assert code == 1
        assert "known:unhealthy" in report["alerts"]
