"""Offline retention boundaries; synthetic files only, never Docker or GPG."""
import datetime as dt
import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess

import pytest

spec = importlib.util.spec_from_file_location(
    "daily_backup", Path(__file__).resolve().parents[2] / "deploy/security/daily_backup.py"
)
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)
NOW = dt.datetime(2026, 11, 2, 3, 30, tzinfo=dt.timezone.utc)


def put(directory, age, *, mtime_age=None):
    when = NOW - dt.timedelta(days=age)
    path = directory / ("maibo-" + when.strftime("%Y%m%dT%H%M%SZ") + ".tar.gz.gpg")
    path.write_bytes(b"synthetic encrypted archive")
    modified = NOW - dt.timedelta(days=age if mtime_age is None else mtime_age)
    os.utime(path, (modified.timestamp(), modified.timestamp()))
    return path


def test_retention_keeps_fourteen_copies_even_when_all_are_older(tmp_path):
    for age in range(20, 40):
        put(tmp_path, age)
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        assert daily.prune(fd, NOW) == 6
        assert len(daily.inventory(fd)) == 14
    finally:
        os.close(fd)


def test_age_boundary_recent_mtime_and_unrelated_entries_are_protected(tmp_path):
    for age in range(1, 20):
        put(tmp_path, age / 24)
    boundary = put(tmp_path, 14)
    recent_copy = put(tmp_path, 30, mtime_age=1)
    expired = put(tmp_path, 31)
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.write_bytes(b"outside")
    link = tmp_path / "maibo-20200101T000000Z.tar.gz.gpg"
    link.symlink_to(outside)
    nested = tmp_path / "maibo-20200102T000000Z.tar.gz.gpg"
    nested.mkdir()
    (nested / "keep").write_bytes(b"keep")
    invalid = tmp_path / "maibo-20209999T000000Z.tar.gz.gpg"
    invalid.write_bytes(b"keep")
    other = tmp_path / "other.tar.gz.gpg"
    other.write_bytes(b"keep")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        assert daily.prune(fd, NOW) == 1
    finally:
        os.close(fd)
    assert not expired.exists()
    assert all(path.exists() for path in (boundary, recent_copy, outside, nested / "keep", invalid, other))
    assert link.is_symlink()


@pytest.mark.parametrize("failure", ["backup", "verify", None])
def test_only_verified_success_can_prune(tmp_path, monkeypatch, failure):
    tmp_path.chmod(0o700)
    old = [put(tmp_path, age) for age in range(20, 40)]
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        assert command[1] == str(daily.BACKUP)
        assert command[2:6] == ["--directory", str(tmp_path), "--key", str(tmp_path / "key")]
        assert kwargs["stdout"] == kwargs["stderr"] == subprocess.DEVNULL
        phase = "verify" if "--verify" in command else "backup"
        if phase == failure:
            raise subprocess.CalledProcessError(1, command, stderr="secret")
        if phase == "backup":
            assert command[-1] == "--quiesce"
            put(tmp_path, 0)

    monkeypatch.setattr(daily.subprocess, "run", fake_run)
    if failure:
        with pytest.raises(subprocess.CalledProcessError):
            daily.execute(tmp_path, tmp_path / "key", NOW)
        assert all(path.exists() for path in old)
    else:
        assert daily.execute(tmp_path, tmp_path / "key", NOW)["removed"] == 7
        assert len(calls) == 2


def test_overlap_skips_and_symlink_directory_is_rejected(tmp_path, monkeypatch):
    tmp_path.chmod(0o700)
    with (tmp_path / ".daily-backup.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        monkeypatch.setattr(daily.subprocess, "run", lambda *a, **kw: pytest.fail("overlap started backup"))
        assert daily.execute(tmp_path, tmp_path / "key")["status"] == "skipped_overlap"
    link = tmp_path / "linked"
    link.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        daily.execute(link, tmp_path / "key")


def test_main_never_logs_child_error_or_private_paths(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(daily.sys, "argv", ["daily_backup.py", "--directory", str(tmp_path), "--key", "/private/secret-key"])
    def fail(*args):
        raise RuntimeError("secret-value /private/secret-key")
    monkeypatch.setattr(daily, "execute", fail)
    assert daily.main() == 1
    output = capsys.readouterr()
    assert "secret" not in output.out + output.err
    assert '"status": "failed"' in output.out


def test_symlink_lock_cannot_touch_outside_file(tmp_path, monkeypatch):
    tmp_path.chmod(0o700)
    outside = tmp_path.parent / (tmp_path.name + "-lock-target")
    outside.write_bytes(b"unchanged")
    (tmp_path / ".daily-backup.lock").symlink_to(outside)
    monkeypatch.setattr(daily.subprocess, "run", lambda *a, **kw: pytest.fail("unsafe lock started backup"))
    with pytest.raises(OSError):
        daily.execute(tmp_path, tmp_path / "key")
    assert outside.read_bytes() == b"unchanged"
