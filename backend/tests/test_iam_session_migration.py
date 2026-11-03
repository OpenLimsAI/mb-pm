"""IAM migration guards; synthetic files only, never connects to a Docker daemon."""

import copy
import importlib.util
import io
from pathlib import Path
import tarfile
import subprocess

import pytest

spec = importlib.util.spec_from_file_location(
    "iam_session_migration",
    Path(__file__).resolve().parents[2] / "deploy/parallel-test/migrate_iam_sessions.py",
)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def configs():
    before = {"services": {"casdoor": {"image": "old-tag", "environment": {"CUSTOM": "private"},
              "volumes": [{"type": "bind", "source": "/conf", "target": "/conf"}],
              "networks": {"internal": {}, "edge": {}}, "mem_limit": "2g"},
              "app": {"image": "untouched"}}, "volumes": {"database": {}}}
    after = copy.deepcopy(before)
    after["services"]["casdoor"]["image"] = "fixed-image"
    for store in migration.STORES.values():
        after["services"]["casdoor"]["volumes"].append({"type": "volume", "source": store["key"], "target": store["path"]})
        after["volumes"][store["key"]] = {"external": True, "name": store["volume"]}
    live = {"Config": {"Env": ["CUSTOM=private", "PATH=/bin"]}}
    image = {"Config": {"Env": ["PATH=/bin"]}}
    return before, after, live, image


def test_only_session_storage_changes_and_live_environment_is_preserved():
    migration.validate_delta(*configs())
    before, after, live, image = configs()
    live["Config"]["Env"].append("UNRECORDED=secret")
    with pytest.raises(ValueError, match="Live environment differs"):
        migration.validate_delta(before, after, live, image)


@pytest.mark.parametrize("change", ["network", "limits", "other_service", "existing_mount", "readonly", "wrong_volume"])
def test_refuses_unrelated_or_unsafe_changes(change):
    before, after, live, image = configs()
    service = after["services"]["casdoor"]
    if change == "network":
        service["networks"].pop("edge")
    elif change == "limits":
        service.pop("mem_limit")
    elif change == "other_service":
        after["services"]["app"]["image"] = "surprise"
    elif change == "existing_mount":
        before["services"]["casdoor"]["volumes"].append({"target": "/tmp", "type": "tmpfs"})
    elif change == "readonly":
        service["volumes"][-1]["read_only"] = True
    else:
        service["volumes"][-1]["source"] = "database"
    with pytest.raises(ValueError):
        migration.validate_delta(before, after, live, image)


def archive(path, name="a/b/session", *, kind=tarfile.REGTYPE, mode=0o600, content=b"synthetic-session"):
    with tarfile.open(path, "w") as output:
        item = tarfile.TarInfo(name)
        item.type, item.mode, item.uid, item.gid = kind, mode, 123, 456
        item.size = len(content) if kind == tarfile.REGTYPE else 0
        output.addfile(item, io.BytesIO(content) if item.size else None)


@pytest.mark.parametrize("name,kind", [("../outside", tarfile.REGTYPE), ("/outside", tarfile.REGTYPE),
                                    ("link", tarfile.SYMTYPE), ("hardlink", tarfile.LNKTYPE)])
def test_rejects_path_escape_and_links(tmp_path, name, kind):
    path = tmp_path / "sessions.tar"
    archive(path, name, kind=kind)
    with pytest.raises(ValueError, match="unsafe"):
        migration.validate_archive(path)


def test_checks_session_bytes_and_permissions_without_extracting(tmp_path):
    a, b = tmp_path / "a.tar", tmp_path / "b.tar"
    archive(a)
    archive(b)
    assert migration.validate_archive(a) == 1
    assert migration.archive_manifest(a) == migration.archive_manifest(b)
    archive(b, mode=0o644)
    assert migration.archive_manifest(a) != migration.archive_manifest(b)
    archive(b, content=b"different")
    assert migration.archive_manifest(a) != migration.archive_manifest(b)


def test_copy_failure_restarts_original_without_replacing_container(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(migration, "run", lambda args, **kwargs: calls.append(args))
    def fail_copy(*args, **kwargs):
        raise RuntimeError("copy failed")
    monkeypatch.setattr(migration.sp, "run", fail_copy)
    with pytest.raises(RuntimeError, match="copy failed"):
        migration.copy_and_seed({"Image": "fixed"}, tmp_path)
    assert calls == [["docker", "stop", "--time", "30", migration.TARGET], ["docker", "start", migration.TARGET]]


def test_failure_copying_logs_restores_original_after_single_stop(monkeypatch, tmp_path):
    calls, seeded = [], []
    monkeypatch.setattr(migration, "run", lambda args, **kwargs: calls.append(args))
    monkeypatch.setattr(migration.sp, "run", lambda *args, **kwargs: None)
    monkeypatch.setattr(migration, "validate_archive", lambda path: 1)
    monkeypatch.setattr(migration, "digest", lambda path: "sha256")
    def seed(live, archive, value):
        seeded.append(value["key"])
        if value["key"] == "casdoor-logs":
            raise ValueError("logs copy failed")
    monkeypatch.setattr(migration, "seed_archive", seed)
    with pytest.raises(ValueError, match="logs copy failed"):
        migration.copy_and_seed({"Image": "fixed"}, tmp_path)
    assert seeded == ["casdoor-sessions", "casdoor-logs"]
    assert calls == [["docker", "stop", "--time", "30", migration.TARGET], ["docker", "start", migration.TARGET]]


def test_existing_log_volume_is_never_overwritten(monkeypatch, tmp_path):
    value = migration.STORES["logs"]
    monkeypatch.setattr(migration.sp, "check_output", lambda *args, **kwargs: (value["volume"] + "\n").encode())
    calls = []
    monkeypatch.setattr(migration, "run", lambda args, **kwargs: calls.append(args))
    with pytest.raises(ValueError, match="refusing to overwrite"):
        migration.seed_archive({"Image": "fixed"}, tmp_path / "logs.tar", value)
    assert calls == []


def test_stop_error_also_attempts_to_restore_original(monkeypatch, tmp_path):
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        if args[1] == "stop":
            raise subprocess.CalledProcessError(1, args)
    monkeypatch.setattr(migration, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        migration.copy_and_seed({"Image": "fixed"}, tmp_path)
    assert calls[-1] == ["docker", "start", migration.TARGET]


def test_rejects_a_differently_named_existing_volume():
    before, after, live, image = configs()
    after["volumes"]["casdoor-logs"]["name"] = "unrelated-data"
    with pytest.raises(ValueError, match="identity differs"):
        migration.validate_delta(before, after, live, image)


def test_missing_replacement_still_retries_same_image_and_volume(monkeypatch):
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise subprocess.CalledProcessError(1, args)
    def missing(args):
        raise subprocess.CalledProcessError(1, args)
    monkeypatch.setattr(migration, "run", run)
    monkeypatch.setattr(migration, "capture", missing)
    ready = []
    monkeypatch.setattr(migration, "wait_ready", lambda *args: ready.append(args))
    migration.replace_iam(["compose", "-f", "populated-volume.json"], {"Id": "old", "Image": "fixed"}, {})
    assert len(calls) == 2
    assert calls[1] == ["compose", "-f", "populated-volume.json", "up", "-d", "--no-deps", "casdoor"]
    assert ready == [("fixed", {})]


def test_second_replacement_failure_is_not_reported_as_success(monkeypatch):
    def failed(args, **kwargs):
        raise subprocess.CalledProcessError(1, args)
    monkeypatch.setattr(migration, "run", failed)
    monkeypatch.setattr(migration, "capture", failed)
    with pytest.raises(RuntimeError, match="recovery failed"):
        migration.replace_iam(["compose"], {"Id": "old", "Image": "fixed"}, {})
