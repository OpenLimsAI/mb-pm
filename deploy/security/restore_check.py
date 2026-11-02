#!/usr/bin/env python3
"""Restore an authenticated backup into new server-local, isolated resources only."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import sqlite3
import subprocess as sp
import tarfile
import time

DATABASES = {"mb-pm-v2-pms-db-1": "mb_pm", "mb-pm-v2-iam-db-1": "casdoor", "dikw-postgres": "dikw"}
LABEL = "org.maibo.restore-check"
MAX_FILES = 200_000
MAX_BYTES = 8 * 1024**3


class RestoreError(Exception):
    """Messages contain fixed operational labels, never archive/SQL content."""


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or "\x00" in name:
        raise RestoreError("Unsafe archive path")
    return path


def extract_archive(archive, target, budget):
    """No tar links, devices, ownership restoration, or writes outside a new tree."""
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    entries = 0
    with tarfile.open(archive, "r:*") as source:
        seen = set()
        for member in source:
            entries += 1
            budget["files"] += 1
            if budget["files"] > MAX_FILES or member.size < 0:
                raise RestoreError("Archive exceeds recovery capacity limit")
            path = safe_name(member.name)
            if not member.isfile() and not member.isdir():
                raise RestoreError("Archive contains links or special files")
            if path == PurePosixPath("."):
                if not member.isdir():
                    raise RestoreError("Invalid archive root")
                continue
            if path in seen:
                raise RestoreError("Duplicate archive path")
            seen.add(path)
            budget["bytes"] += member.size
            if budget["files"] > MAX_FILES or budget["bytes"] > MAX_BYTES:
                raise RestoreError("Archive exceeds recovery capacity limit")
            destination = target.joinpath(*path.parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with source.extractfile(member) as content, destination.open("xb") as output:
                    shutil.copyfileobj(content, output, 1024 * 1024)
                destination.chmod(0o700 if member.mode & 0o111 else 0o600)
    return entries


def validate_manifest(root):
    manifest = json.loads((root / "manifest.json").read_text())
    hashes = manifest.get("sha256")
    if not isinstance(hashes, dict):
        raise RestoreError("Missing backup checksums")
    actual = {path.name for path in root.iterdir() if path.is_file() and path.name != "manifest.json"}
    if set(hashes) != actual or any(path.is_dir() for path in root.iterdir()):
        raise RestoreError("Backup manifest does not cover every payload")
    for name, expected in hashes.items():
        if safe_name(name).name != name or not re.fullmatch(r"[0-9a-f]{64}", str(expected)):
            raise RestoreError("Invalid checksum record")
        if sha256(root / name) != expected:
            raise RestoreError("Backup payload checksum mismatch")
    rows = manifest.get("databases")
    if not isinstance(rows, list) or len(rows) != len(DATABASES):
        raise RestoreError("Backup must contain the three required databases")
    seen = set()
    for row in rows:
        source, database, filename = row.get("container"), row.get("database"), row.get("file")
        if source in seen or DATABASES.get(source) != database or filename != database + ".dump" or filename not in hashes:
            raise RestoreError("Unexpected database manifest")
        seen.add(source)
    mounts = manifest.get("mounts")
    if not isinstance(mounts, list):
        raise RestoreError("Missing backup mount inventory")
    mount_files = [mount.get("file") for mount in mounts]
    if any(not isinstance(name, str) or not re.fullmatch(r"mount-[0-9]+\.tar", name) for name in mount_files) or len(set(mount_files)) != len(mount_files):
        raise RestoreError("Invalid mount archive inventory")
    expected_files = {"runtime-inspect.json", *(database + ".dump" for database in DATABASES.values()), *mount_files}
    if "config-files.tar" in hashes:
        expected_files.add("config-files.tar")
    if set(hashes) != expected_files:
        raise RestoreError("Backup contains unsupported or unlisted payloads")
    inspected = json.loads((root / "runtime-inspect.json").read_text())
    images = {item["Name"].lstrip("/"): item.get("Image") for item in inspected}
    if any(not re.fullmatch(r"sha256:[0-9a-f]{64}", str(images.get(name))) for name in DATABASES):
        raise RestoreError("Backup lacks immutable database image IDs")
    return manifest, images


def sqlite_checks(root):
    checked, tables, rows = 0, 0, 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            if stream.read(16) != b"SQLite format 3\x00":
                if path.suffix in (".sqlite", ".sqlite3"):
                    raise RestoreError("Restored SQLite header is invalid")
                continue
        # Work on the isolated copy, with its WAL/SHM beside it; immutable=1
        # would ignore committed WAL changes and is deliberately not used.
        connection = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True)
        try:
            if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RestoreError("Restored SQLite integrity check failed")
            names = connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
            for (name,) in names:
                quoted = '"' + name.replace('"', '""') + '"'
                rows += connection.execute("SELECT COUNT(*) FROM " + quoted).fetchone()[0]
            tables += len(names)
            checked += 1
        finally:
            connection.close()
    return {"databases": checked, "tables": tables, "rows": rows, "integrity": "ok"}


def command(args, log, **kwargs):
    result = sp.run(args, stdout=sp.PIPE, stderr=log, check=False, timeout=900, **kwargs)
    if result.returncode:
        raise RestoreError("Recovery command failed; private server log retained")
    return result.stdout


COUNT_SQL = """
CREATE TEMP TABLE restore_totals (tables bigint, rows bigint);
DO $$ DECLARE target record; n bigint; total bigint := 0; tab bigint := 0;
BEGIN
 FOR target IN SELECT nspname,relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='r' AND nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
 LOOP
  EXECUTE format('SELECT count(*) FROM %I.%I',target.nspname,target.relname) INTO n;
  total := total+n; tab := tab+1;
 END LOOP;
 INSERT INTO restore_totals VALUES(tab,total);
END $$;
SELECT json_build_object('tables',tables,'rows',rows) FROM restore_totals;
"""


def restore_database(row, image, root, network, prefix, resources, log):
    database = row["database"]
    if DATABASES.get(row["container"]) != database or network != prefix or not re.fullmatch(r"maibo-restore-[a-z0-9-]+", prefix) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise RestoreError("Invalid isolated resource identity")
    name = prefix + "-" + database.replace("_", "-")
    volume = name + "-data"
    user, password = "restore_" + secrets.token_hex(8), secrets.token_urlsafe(48)
    env = root / (database + ".env")
    env.write_text("POSTGRES_USER=" + user + "\nPOSTGRES_PASSWORD=" + password + "\nPOSTGRES_DB=" + database + "\nPGDATA=/var/lib/postgresql/data\n")
    env.chmod(0o600)
    connection = root / (database + ".connection.env")
    connection.write_text("DATABASE_URL=postgresql://" + user + ":" + password + "@" + name + ":5432/" + database + "\n")
    connection.chmod(0o600)
    command(["docker", "image", "inspect", image], log)
    command(["docker", "volume", "create", "--label", LABEL + "=" + prefix, volume], log)
    resources["volumes"].append(volume)
    command(["docker", "run", "--detach", "--pull=never", "--name", name,
             "--network", network, "--label", LABEL + "=" + prefix,
             "--env-file", str(env), "--mount", "type=volume,source=" + volume + ",target=/var/lib/postgresql",
             "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--pids-limit", "128",
             "--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=2", image], log)
    resources["containers"].append(name)
    deadline = time.monotonic() + 120
    while True:
        # The image's temporary init server only listens on a Unix socket.
        # Wait for final TCP readiness before importing any customer tables.
        result = sp.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", user, "-d", database], stdout=sp.DEVNULL, stderr=log, timeout=15)
        if result.returncode == 0:
            break
        if time.monotonic() >= deadline:
            raise RestoreError("Isolated database did not become ready")
        time.sleep(1)
    with (root / "payload" / row["file"]).open("rb") as dump:
        command(["docker", "exec", "-i", name, "pg_restore", "-U", user, "-d", database,
                 "--no-owner", "--no-acl", "--exit-on-error"], log, stdin=dump)
    counts = json.loads(command(["docker", "exec", "-i", name, "psql", "-U", user, "-d", database, "-qAt", "-v", "ON_ERROR_STOP=1"], log, input=COUNT_SQL.encode()))
    if any(type(counts.get(key)) is not int or counts[key] < 0 for key in ("tables", "rows")):
        raise RestoreError("Invalid restored database counts")
    inspected = json.loads(command(["docker", "inspect", name], log))[0]
    if inspected["HostConfig"].get("PortBindings") or set(inspected["NetworkSettings"]["Networks"]) != {network}:
        raise RestoreError("Isolated database network verification failed")
    return {"database": database, "container": name, "volume": volume, "image": image, "tables": counts["tables"], "rows": counts["rows"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.key.is_symlink() or not args.key.is_file() or args.key.stat().st_mode & 0o077:
        raise RestoreError("Recovery key must be a private regular file")
    root = args.directory.resolve()
    if not root.is_relative_to(Path.home()) or root == Path.home() or root.exists():
        raise RestoreError("Recovery directory must be a new path under server home")
    if shutil.disk_usage(root.parent).free < 5 * 1024**3:
        raise RestoreError("Insufficient space for isolated recovery")
    root.mkdir(mode=0o700)
    prefix = "maibo-restore-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + secrets.token_hex(3)
    resources = {"network": prefix, "containers": [], "volumes": []}
    report = {"status": "running", "directory": str(root), "resources": resources, "databases": []}
    phase = "authentication"
    with (root / "restore.private.log").open("xb") as log:
        try:
            gnupg = root / "gnupg"
            gnupg.mkdir(mode=0o700)
            plain = root / "authenticated.tar.gz"
            with plain.open("xb") as output:
                result = sp.run(["gpg", "--homedir", str(gnupg), "--batch", "--pinentry-mode", "loopback", "--passphrase-file", str(args.key), "--decrypt", str(args.backup)], stdout=output, stderr=log, timeout=900)
            if result.returncode:
                raise RestoreError("Backup authentication failed")
            report["backup_authenticated"] = True
            phase = "manifest"
            budget = {"files": 0, "bytes": 0}
            extract_archive(plain, root / "payload", budget)
            manifest, images = validate_manifest(root / "payload")
            report["verified_payloads"] = len(manifest["sha256"])
            phase = "files"
            mounts = manifest.get("mounts")
            if not isinstance(mounts, list):
                raise RestoreError("Missing backup mount inventory")
            restored = root / "restored-files"
            restored.mkdir(mode=0o700)
            inventory = []
            for index, mount in enumerate(mounts, 1):
                filename = mount.get("file")
                if not isinstance(filename, str) or not re.fullmatch(r"mount-[0-9]+\.tar", filename) or filename not in manifest["sha256"]:
                    raise RestoreError("Invalid mount archive identity")
                destination = restored / ("mount-" + str(index))
                extract_archive(root / "payload" / filename, destination, budget)
                mount_root = destination / PurePosixPath(mount["destination"]).name
                if not mount_root.exists() or mount_root == destination:
                    raise RestoreError("Restored mount root does not match its destination")
                inventory.append({**mount, "archive_directory": str(destination), "restored_path": str(mount_root)})
            if "config-files.tar" in manifest["sha256"]:
                extract_archive(root / "payload/config-files.tar", restored / "configuration", budget)
            (root / "mounts.private.json").write_text(json.dumps(inventory, indent=2))
            report["restored_mounts"] = len(inventory)
            report["sqlite"] = sqlite_checks(restored)
            report["archive_entries"] = budget["files"]
            report["archive_bytes"] = budget["bytes"]
            phase = "databases"
            command(["docker", "network", "create", "--internal", "--label", LABEL + "=" + prefix, prefix], log)
            network_info = json.loads(command(["docker", "network", "inspect", prefix], log))[0]
            if not network_info.get("Internal"):
                raise RestoreError("Recovery network must be internal")
            for row in manifest["databases"]:
                report["databases"].append(restore_database(row, images[row["container"]], root, prefix, prefix, resources, log))
            report["status"] = "verified"
        except Exception:
            # The private log/archives stay on the server. Do not stringify
            # exceptions: SQL diagnostics can contain customer values.
            report["status"] = "failed"
            report["failed_phase"] = phase
        finally:
            (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    raise SystemExit(0 if report["status"] == "verified" else 1)


if __name__ == "__main__":
    try:
        main()
    except (RestoreError, OSError, ValueError, sp.SubprocessError):
        print(json.dumps({"status": "failed", "failed_phase": "preflight"}))
        raise SystemExit(1)
