"""Offline restore safety tests: synthetic archives, no Docker/GPG or remote calls."""

import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tarfile
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location(
    "security_restore", Path(__file__).resolve().parents[2] / "deploy/security/restore_check.py"
)
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


@pytest.mark.parametrize("name,kind", [
    ("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
    ("folder/../../escape", tarfile.REGTYPE), ("windows\\escape", tarfile.REGTYPE),
    ("link", tarfile.SYMTYPE), ("hardlink", tarfile.LNKTYPE), ("device", tarfile.CHRTYPE),
])
def test_archive_paths_and_special_members_cannot_escape(tmp_path, name, kind):
    archive = tmp_path / "archive.tar"
    with tarfile.open(archive, "w") as output:
        member = tarfile.TarInfo(name)
        member.type = kind
        member.linkname = "../../outside"
        output.addfile(member)
    with pytest.raises(restore.RestoreError):
        restore.extract_archive(archive, tmp_path / "restored", {"files": 0, "bytes": 0})
    assert not (tmp_path / "escape").exists()


def test_duplicate_members_and_unpacked_size_are_rejected(tmp_path, monkeypatch):
    archive = tmp_path / "archive.tar"
    with tarfile.open(archive, "w") as output:
        member = tarfile.TarInfo("nested/data")
        member.size = 2
        output.addfile(member, io.BytesIO(b"ok"))
        output.addfile(member, io.BytesIO(b"ok"))
    with pytest.raises(restore.RestoreError, match="Duplicate"):
        restore.extract_archive(archive, tmp_path / "duplicate", {"files": 0, "bytes": 0})
    monkeypatch.setattr(restore, "MAX_BYTES", 1)
    with pytest.raises(restore.RestoreError, match="capacity"):
        restore.extract_archive(archive, tmp_path / "oversize", {"files": 0, "bytes": 0})


def manifest_fixture(root):
    root.mkdir()
    manifest = {"databases": [], "mounts": [], "sha256": {}}
    inspected = []
    for container, database in restore.DATABASES.items():
        filename = database + ".dump"
        (root / filename).write_bytes(b"synthetic dump")
        manifest["databases"].append({"container": container, "database": database, "file": filename})
        inspected.append({"Name": "/" + container, "Image": "sha256:" + "a" * 64})
    (root / "runtime-inspect.json").write_text(json.dumps(inspected))
    manifest["sha256"] = {path.name: restore.sha256(path) for path in root.iterdir()}
    (root / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def test_manifest_authenticates_every_payload_and_requires_exact_database_set(tmp_path):
    root = tmp_path / "payload"
    manifest_fixture(root)
    manifest, images = restore.validate_manifest(root)
    assert set(images) == set(restore.DATABASES)
    (root / "mb_pm.dump").write_bytes(b"tampered")
    with pytest.raises(restore.RestoreError, match="checksum mismatch"):
        restore.validate_manifest(root)
    (root / "mb_pm.dump").write_bytes(b"synthetic dump")
    (root / "unlisted").write_bytes(b"unlisted")
    with pytest.raises(restore.RestoreError, match="every payload"):
        restore.validate_manifest(root)
    (root / "unlisted").unlink()
    manifest["databases"][0] = manifest["databases"][1]
    (root / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(restore.RestoreError, match="database manifest"):
        restore.validate_manifest(root)


def test_sqlite_checks_include_wal_and_return_only_counts(tmp_path):
    database = sqlite3.connect(tmp_path / "records.sqlite")
    try:
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("CREATE TABLE private_records(value TEXT)")
        database.execute("INSERT INTO private_records VALUES('synthetic-private-value')")
        database.commit()
        assert (tmp_path / "records.sqlite-wal").exists()
        result = restore.sqlite_checks(tmp_path)
        assert result == {"databases": 1, "tables": 1, "rows": 1, "integrity": "ok"}
        assert "synthetic-private-value" not in json.dumps(result)
    finally:
        database.close()


def test_invalid_sqlite_header_cannot_be_silently_skipped(tmp_path):
    (tmp_path / "records.sqlite").write_bytes(b"damaged fixture")
    with pytest.raises(restore.RestoreError, match="header"):
        restore.sqlite_checks(tmp_path)


def test_database_restore_only_targets_new_isolated_resources(tmp_path, monkeypatch):
    prefix = "maibo-restore-synthetic"
    (tmp_path / "payload").mkdir()
    (tmp_path / "payload/mb_pm.dump").write_bytes(b"synthetic dump")
    commands = []
    monkeypatch.setattr(restore.secrets, "token_urlsafe", lambda n: "synthetic-private-password")

    def command(args, log, **kwargs):
        commands.append(args)
        if args[:2] == ["docker", "inspect"]:
            return json.dumps([{"HostConfig": {"PortBindings": {}}, "NetworkSettings": {"Networks": {prefix: {}}}}]).encode()
        if "psql" in args:
            return b'{"tables": 3, "rows": 7}'
        return b""

    monkeypatch.setattr(restore, "command", command)
    monkeypatch.setattr(restore.sp, "run", lambda args, **kwargs: SimpleNamespace(returncode=0))
    resources = {"containers": [], "volumes": []}
    result = restore.restore_database(
        {"container": "mb-pm-v2-pms-db-1", "database": "mb_pm", "file": "mb_pm.dump"},
        "sha256:" + "a" * 64, tmp_path, prefix, prefix, resources, io.BytesIO(),
    )
    assert result["tables"] == 3 and result["rows"] == 7
    assert all("mb-pm-v2-pms-db-1" not in args for args in commands)
    run = next(args for args in commands if args[:2] == ["docker", "run"])
    assert "--publish" not in run and "-p" not in run
    assert run[run.index("--network") + 1] == prefix
    assert "target=/var/lib/postgresql" in run[run.index("--mount") + 1]
    pg_restore = next(args for args in commands if "pg_restore" in args)
    assert {"--no-owner", "--no-acl", "--exit-on-error"}.issubset(pg_restore)
    assert "synthetic-private-password" not in json.dumps(commands) + json.dumps(result)
    assert (tmp_path / "mb_pm.env").stat().st_mode & 0o777 == 0o600
    assert resources["containers"] == [prefix + "-mb-pm"]


def test_failed_decryption_never_extracts_or_contacts_docker(tmp_path, monkeypatch, capsys):
    key = tmp_path / "key"
    key.write_text("synthetic-key")
    key.chmod(0o600)
    output = tmp_path / "recovery"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(restore.shutil, "disk_usage", lambda path: SimpleNamespace(free=10 * 1024**3))
    monkeypatch.setattr(sys, "argv", ["restore", "--backup", str(tmp_path / "backup.gpg"), "--key", str(key), "--directory", str(output)])
    called = []

    def run(args, **kwargs):
        called.append(args)
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr(restore.sp, "run", run)
    with pytest.raises(SystemExit) as result:
        restore.main()
    assert result.value.code == 1
    assert len(called) == 1 and called[0][0] == "gpg"
    assert not (output / "payload").exists()
    assert json.loads((output / "report.json").read_text())["failed_phase"] == "authentication"
    assert "synthetic-key" not in capsys.readouterr().out
