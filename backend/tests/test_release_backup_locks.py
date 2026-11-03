"""Real process locks must serialize deployments with both backup entrypoints."""

import contextlib
import copy
import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "deploy/security/release.py"
spec = importlib.util.spec_from_file_location("release_backup_locks", SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

HOLDER = """
import fcntl,sys
with open(sys.argv[1], 'a') as stream:
    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('ready', flush=True)
    sys.stdin.readline()
"""
PROBE = """
import fcntl,sys
with open(sys.argv[1], 'a') as stream:
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(23)
"""


@contextlib.contextmanager
def held_by_another_process(path):
    process = subprocess.Popen(
        [sys.executable, "-c", HOLDER, str(path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout.readline().strip() == "ready"
        yield
    finally:
        process.communicate("release\n", timeout=5)
        assert process.returncode == 0


def can_lock_in_another_process(path):
    result = subprocess.run(
        [sys.executable, "-c", PROBE, str(path)], capture_output=True, timeout=5
    )
    assert result.returncode in (0, 23), result.stderr
    return result.returncode == 0


@pytest.fixture
def locations(tmp_path):
    root = tmp_path / "production"
    backup = tmp_path / "daily"
    root.mkdir()
    backup.mkdir()
    return root, backup


def lock_paths(root, backup):
    return (
        backup / ".daily-backup.lock",
        backup / ".backup.lock",
        root / ".security-release.lock",
    )


@pytest.mark.parametrize("index", [0, 1, 2])
def test_cross_process_conflict_releases_partial_acquisitions(locations, index):
    root, backup = locations
    paths = lock_paths(root, backup)
    with held_by_another_process(paths[index]):
        with pytest.raises(BlockingIOError):
            with release.release_locks(root, backup):
                pytest.fail("Conflicting deployment entered its mutation section")
        for path in paths[:index]:
            assert can_lock_in_another_process(path)
    assert all(can_lock_in_another_process(path) for path in paths)


def test_locks_remain_held_during_failed_rollout_and_rollback(locations, monkeypatch):
    root, backup = locations
    paths = lock_paths(root, backup)
    commands = []

    def run(command, **kwargs):
        assert all(not can_lock_in_another_process(path) for path in paths)
        commands.append(command[0])
        if command[0] == "candidate":
            raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(release.sp, "run", run)
    # Use the real subprocess implementation for the competing lock probe.
    monkeypatch.setattr(sys.modules[__name__], "can_lock_in_another_process", _probe)
    with pytest.raises(RuntimeError, match="previous services restored"):
        with release.release_locks(root, backup):
            release.rollout(["candidate"], ["previous"])
    assert commands == ["candidate", "previous"]
    assert all(_probe(path) for path in paths)


def _probe(path):
    process = subprocess.Popen(
        [sys.executable, "-c", PROBE, str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    _, error = process.communicate(timeout=5)
    assert process.returncode in (0, 23), error
    return process.returncode == 0


def test_success_and_interrupt_release_all_locks(locations):
    root, backup = locations
    paths = lock_paths(root, backup)
    for interrupt in (False, True):
        try:
            with release.release_locks(root, backup):
                assert all(not _probe(path) for path in paths)
                if interrupt:
                    raise KeyboardInterrupt
        except KeyboardInterrupt:
            pass
        assert all(_probe(path) for path in paths)


def test_missing_backup_directory_does_not_create_false_lock_domain(locations):
    root, backup = locations
    missing = backup / "absent"
    with pytest.raises(SystemExit, match="backup directory"):
        with release.release_locks(root, missing):
            pytest.fail("Missing directory must fail closed")
    assert not missing.exists()
    assert not (root / ".security-release.lock").exists()


@pytest.mark.parametrize("kind", ["directory", "lock"])
def test_symlinks_cannot_redirect_backup_lock_domain(locations, kind):
    root, backup = locations
    if kind == "directory":
        selected = root / "alias"
        selected.symlink_to(backup, target_is_directory=True)
    else:
        selected = backup
        (backup / ".daily-backup.lock").symlink_to(root / "other-lock")
    with pytest.raises((SystemExit, OSError)):
        with release.release_locks(root, selected):
            pytest.fail("Symlink lock domain must be rejected")
    assert not (root / "other-lock").exists()


@pytest.mark.parametrize("index", [0, 1, "missing", "recreated", "compose", "envfile"])
def test_apply_cannot_write_overlay_or_rebuild_while_backup_holds_lock(
    locations, monkeypatch, index
):
    root, backup = locations
    if index == "missing":
        backup = backup / "absent"
    runtime = root / "runtime.env"
    runtime.write_text("PMS_RUNTIME_DATABASE_URL=synthetic")
    runtime.chmod(0o600)
    compose = root / "compose.yml"
    compose.write_text("services: {}")
    (root / ".env").write_text("SETTING=original")
    overlay = root / "security.yml"
    overlay.write_text("services: {}")
    image = "sha256:" + "1" * 64
    labels = {
        "com.docker.compose.project.config_files": str(compose),
        "com.docker.compose.project.working_dir": str(root),
        "com.docker.compose.project": "synthetic",
    }
    containers = [{"Id": str(n), "Image": image, "Config": {"Labels": labels}} for n in range(2)]
    inspect_count = 0

    def capture(command):
        nonlocal inspect_count
        if command[:2] == ["docker", "inspect"]:
            inspect_count += 1
            current = copy.deepcopy(containers)
            if index == "recreated" and inspect_count > 1:
                current[0]["Id"] = "replaced-with-same-image"
            return current
        if command[:3] == ["docker", "image", "inspect"]:
            return [{"Config": {}}, {"Config": {}}]
        return {"services": {}}

    def preflight_run(*args, **kwargs):
        if index == "compose":
            compose.write_text("services: {changed: {}}")
        elif index == "envfile":
            (root / ".env").write_text("SETTING=concurrent-update")

    monkeypatch.setattr(release, "capture", capture)
    monkeypatch.setattr(release, "validate_configs", lambda *args: None)
    monkeypatch.setattr(release.sp, "run", preflight_run)
    monkeypatch.setattr(release, "rollout", lambda *args: pytest.fail("Must not rebuild"))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "release",
            "--expected-current",
            image,
            "--image",
            image,
            "--runtime-env",
            str(runtime),
            "--overlay",
            str(overlay),
            "--backup-directory",
            str(backup),
            "--apply",
        ],
    )
    holder = (
        contextlib.nullcontext()
        if isinstance(index, str)
        else held_by_another_process(lock_paths(root, backup)[index])
    )
    with holder:
        with pytest.raises(SystemExit if isinstance(index, str) else BlockingIOError):
            release.main()
    assert not list(root.glob("*.active.yml"))
    assert not list(root.glob("*.rollback*"))
