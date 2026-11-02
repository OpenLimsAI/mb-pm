#!/usr/bin/env python3
"""Server-only encrypted recovery backup; credentials never enter command output."""

import argparse
import datetime as dt
import hashlib
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess as sp
import tempfile
import time

WRITERS = [
    "mb-pm-v2-app-1",
    "mb-pm-v2-app-direct-1",
    "dikw-mbweb",
    "dikw-core",
    "dikw-web",
    "mb-pm-v2-casdoor-1",
    "mb-pm-v2-direct-proxy-1",
]
DATABASES = {
    "mb-pm-v2-pms-db-1": "mb_pm",
    "mb-pm-v2-iam-db-1": "casdoor",
    "dikw-postgres": "dikw",
}


def run(args, **kwargs):
    return sp.run(args, check=True, **kwargs)


def validate_include(path, directory, home=None):
    real, backup = path.resolve(strict=True), directory.resolve()
    home = home or Path.home()
    if (
        not real.is_relative_to(home)
        or real == home
        or real.is_relative_to(backup)
        or backup.is_relative_to(real)
    ):
        raise SystemExit(
            "Include must be explicit under server home, and cannot contain or be inside the backup directory"
        )
    return real


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wait_for_writers(names, inspected, timeout=120):
    deadline = time.monotonic() + timeout
    waiting = set(names)
    while waiting:
        states = json.loads(sp.check_output(["docker", "inspect", *sorted(waiting)]))
        for item in states:
            name = item["Name"].lstrip("/")
            state = item["State"]
            expected_health = "Health" in inspected[name]["State"]
            if state.get("Running") and (
                not expected_health
                or state.get("Health", {}).get("Status") == "healthy"
            ):
                waiting.discard(name)
        if not waiting:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(
                "Backup writers did not recover healthy: " + ", ".join(sorted(waiting))
            )
        time.sleep(2)


def collect_mounts(writers, info):
    mounts = {}
    for name in writers:
        for mount in info[name].get("Mounts", []):
            if mount["Type"] not in ("bind", "volume"):
                continue  # tmpfs is deliberately ephemeral.
            if mount["Destination"] == "/":
                raise SystemExit("Refusing an unrestricted root mount")
            mounts.setdefault((mount["Type"], mount["Source"]), (name, mount))
    return mounts


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--directory", type=Path, required=True)
    p.add_argument("--include", type=Path, action="append", default=[])
    p.add_argument("--verify", type=Path)
    p.add_argument("--key", type=Path, required=True)
    p.add_argument(
        "--quiesce",
        action="store_true",
        help="Explicit short maintenance window: stop all writers, dump DBs/copy mounts, restart in finally",
    )
    p.add_argument(
        "--writer",
        action="append",
        default=[],
        help="Additional writer container; never replaces the required stack",
    )
    args = p.parse_args()
    os.umask(0o077)
    args.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.key.exists() and args.key.stat().st_mode & 0o077:
        raise SystemExit("Backup key permissions must be 0600")
    if not args.key.exists():
        if args.verify:
            raise SystemExit("Backup key is required")
        args.key.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with args.key.open("x") as output:
            output.write(secrets.token_urlsafe(64) + "\n")
    gpg = [
        "gpg",
        "--batch",
        "--yes",
        "--pinentry-mode",
        "loopback",
        "--passphrase-file",
        str(args.key),
    ]
    if args.verify:
        with tempfile.TemporaryFile() as plain:
            run(gpg + ["--decrypt", str(args.verify)], stdout=plain, stderr=sp.DEVNULL)
            plain.seek(0)
            run(["tar", "-tzf", "-"], stdin=plain, stdout=sp.DEVNULL)
        print("Encrypted backup authentication and archive integrity verified")
        return
    if not args.quiesce:
        raise SystemExit(
            "A consistent release backup requires --quiesce and a short approved maintenance window; online live SQLite tar is not a recovery snapshot"
        )
    backup_lock = (args.directory / ".backup.lock").open("a")
    fcntl.flock(backup_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if shutil.disk_usage(args.directory).free < 5 * 1024**3:
        raise SystemExit(
            "Less than 5 GiB available; backup aborted before stopping writers"
        )
    writers = list(dict.fromkeys([*WRITERS, *args.writer]))
    names = [*writers, *DATABASES]
    inspected = json.loads(sp.check_output(["docker", "inspect", *names]))
    info = {item["Name"].lstrip("/"): item for item in inspected}
    if any(info[name]["State"].get("Paused") for name in writers):
        raise SystemExit("A writer is already paused; resolve its state before backup")
    if any(not info[name]["State"].get("Running") for name in DATABASES):
        raise SystemExit("Every database must be running for logical dumps")
    paths = list(args.include)
    for item in inspected:
        labels = item["Config"].get("Labels") or {}
        paths.extend(
            Path(path)
            for path in labels.get("com.docker.compose.project.config_files", "").split(
                ","
            )
            if path
        )
        if labels.get("com.docker.compose.project.working_dir"):
            env_file = Path(labels["com.docker.compose.project.working_dir"]) / ".env"
            if env_file.is_file():
                paths.append(env_file)
    includes = sorted({validate_include(path, args.directory) for path in paths})
    mounts = collect_mounts(writers, info)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    final = args.directory / ("maibo-" + stamp + ".tar.gz.gpg")
    partial = final.with_suffix(".partial")
    stopped = []
    try:
        with tempfile.TemporaryDirectory(
            prefix="backup-stage-", dir=args.directory
        ) as stage:
            root = Path(stage)
            manifest = {
                "created_at": stamp,
                "consistency": "all application writers stopped; PostgreSQL logical dumps",
                "databases": [],
                "mounts": [],
                "includes": [str(path) for path in includes],
                "sha256": {},
            }
            # Inspect output is sensitive: it is staged mode 0600 and enters only
            # the encrypted archive, so complete live configuration is recoverable.
            (root / "runtime-inspect.json").write_text(json.dumps(inspected))
            try:
                for name in writers:
                    if info[name]["State"].get("Running"):
                        stopped.append(name)
                        run(["docker", "stop", "--time", "30", name], stdout=sp.DEVNULL)
                stopped_state = json.loads(
                    sp.check_output(["docker", "inspect", *writers])
                )
                if any(item["State"].get("Running") for item in stopped_state):
                    raise RuntimeError(
                        "A writer resumed unexpectedly; snapshot aborted"
                    )
                if includes:
                    entries = [str(path).lstrip("/") for path in includes]
                    run(
                        [
                            "tar",
                            "-cf",
                            str(root / "config-files.tar"),
                            "-C",
                            "/",
                            *entries,
                        ]
                    )
                    run(
                        ["tar", "-tf", str(root / "config-files.tar")],
                        stdout=sp.DEVNULL,
                    )
                for container, database in DATABASES.items():
                    env = dict(
                        item.split("=", 1)
                        for item in info[container]["Config"]["Env"]
                        if "=" in item
                    )
                    user = env.get("POSTGRES_USER", "postgres")
                    filename = database + ".dump"
                    with (root / filename).open("xb") as output:
                        run(
                            [
                                "docker",
                                "exec",
                                container,
                                "pg_dump",
                                "-U",
                                user,
                                "-d",
                                database,
                                "-Fc",
                            ],
                            stdout=output,
                        )
                    with (root / filename).open("rb") as dump:
                        run(
                            ["docker", "exec", "-i", container, "pg_restore", "--list"],
                            stdin=dump,
                            stdout=sp.DEVNULL,
                        )
                    manifest["databases"].append(
                        {"container": container, "database": database, "file": filename}
                    )
                for index, (container, mount) in enumerate(mounts.values(), start=1):
                    filename = f"mount-{index:02d}.tar"
                    # docker cp streams a tar from stopped containers, preserving
                    # SQLite and WAL together and covering Core /base and IAM config.
                    with (root / filename).open("xb") as output:
                        run(
                            [
                                "docker",
                                "cp",
                                f"{container}:{mount['Destination']}",
                                "-",
                            ],
                            stdout=output,
                        )
                    run(["tar", "-tf", str(root / filename)], stdout=sp.DEVNULL)
                    manifest["mounts"].append(
                        {
                            "container": container,
                            "type": mount["Type"],
                            "source": mount["Source"],
                            "destination": mount["Destination"],
                            "file": filename,
                        }
                    )
            finally:
                failures = []
                for name in reversed(stopped):
                    try:
                        run(["docker", "start", name], stdout=sp.DEVNULL)
                    except sp.CalledProcessError:
                        failures.append(name)
                restarted = [name for name in stopped if name not in failures]
                stopped.clear()
                if failures:
                    raise RuntimeError(
                        "Backup window ended but containers require immediate restart: "
                        + ", ".join(failures)
                    )
                if restarted:
                    wait_for_writers(restarted, info)
            for path in root.iterdir():
                manifest["sha256"][path.name] = sha256(path)
            (root / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2)
            )
            with partial.open("xb") as encrypted:
                tar = sp.Popen(["tar", "-czf", "-", "-C", stage, "."], stdout=sp.PIPE)
                try:
                    run(
                        gpg
                        + [
                            "--symmetric",
                            "--cipher-algo",
                            "AES256",
                            "--compress-algo",
                            "none",
                            "--output",
                            "-",
                        ],
                        stdin=tar.stdout,
                        stdout=encrypted,
                        stderr=sp.DEVNULL,
                    )
                finally:
                    tar.stdout.close()
                    result = tar.wait()
                if result:
                    raise RuntimeError(
                        "Snapshot changed or archive failed; incomplete backup rejected"
                    )
            run(gpg + ["--decrypt", str(partial)], stdout=sp.DEVNULL, stderr=sp.DEVNULL)
            partial.replace(final)
        print("Encrypted consistent backup created:", final.name)
        print(
            "All previously running writers restarted. Off-host transfer is NOT configured."
        )
        print(
            "Retain a protected recovery copy of the backup key; restore drills remain required."
        )
    finally:
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
