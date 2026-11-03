#!/usr/bin/env python3
"""Preserve Casdoor sessions and diagnostic logs in independent durable volumes.

Default: read-only preflight. --apply briefly stops ONLY IAM, copies its session
files with ownership/modes intact, seeds a new volume, and recreates the same image
using every live Compose overlay. Never reads or prints session file contents.
"""

import argparse
from contextlib import ExitStack
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess as sp
import tarfile
import tempfile
import time
import urllib.request

TARGET = "mb-pm-v2-casdoor-1"
STORES = {
    "sessions": {"key": "casdoor-sessions", "volume": "mb-pm-v2-casdoor-sessions", "path": "/tmp"},
    "logs": {"key": "casdoor-logs", "volume": "mb-pm-v2-casdoor-logs", "path": "/logs"},
}
VOLUME = STORES["sessions"]["volume"]  # Compatibility for existing review tooling.
LOCKS = (".iam-security-release.lock", ".security-release.lock", ".release.lock")


def capture(args):
    return json.loads(sp.check_output(args, stderr=sp.DEVNULL))


def run(args, **kwargs):
    return sp.run(args, check=True, stdout=sp.DEVNULL, stderr=sp.DEVNULL, **kwargs)


def digest(path):
    with path.open("rb") as stream:
        value = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def write_private(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def overlay(image):
    return {
        "services": {"casdoor": {"image": image, "volumes": [
            value["key"] + ":" + value["path"] for value in STORES.values()
        ]}},
        "volumes": {value["key"]: {"external": True, "name": value["volume"]}
                    for value in STORES.values()},
    }


def validate_delta(before, after, live, image_info):
    prior = copy.deepcopy(before)
    new = copy.deepcopy(after)
    old_service = prior["services"]["casdoor"]
    new_service = new["services"]["casdoor"]
    mounts = new_service.get("volumes", [])
    targets = {value["path"] for value in STORES.values()}
    for value in STORES.values():
        added = [mount for mount in mounts if mount.get("target") == value["path"]]
        if len(added) != 1 or any(
            added[0].get(key) != expected for key, expected in
            {"type": "volume", "source": value["key"], "target": value["path"]}.items()
        ) or added[0].get("read_only", False):
            raise ValueError("Expected exactly one writable IAM " + value["key"] + " volume")
        definition = new.get("volumes", {}).get(value["key"], {})
        if definition.get("name") != value["volume"] or definition.get("external") is not True:
            raise ValueError("Persistent IAM volume identity differs from migration target")
        if any(m.get("target") == value["path"] for m in old_service.get("volumes", [])):
            raise ValueError("IAM already has a " + value["path"] + " mount; review rather than replace it")
        prior.get("volumes", {}).pop(value["key"], None)
        new.get("volumes", {}).pop(value["key"], None)
    new_service["volumes"] = [mount for mount in mounts if mount.get("target") not in targets]
    old_service.pop("image", None)
    new_service.pop("image", None)
    if prior != new:
        raise ValueError("Refuse changes outside IAM session storage and fixed image reference")
    effective = dict(item.split("=", 1) for item in image_info["Config"].get("Env", []))
    effective.update({key: value.replace("$$", "$") if isinstance(value, str) else value
                      for key, value in old_service.get("environment", {}).items()})
    if effective != dict(item.split("=", 1) for item in live["Config"].get("Env", [])):
        raise ValueError("Live environment differs from Compose; reconcile before migration")


def validate_archive(path):
    count = 0
    with tarfile.open(path) as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isdir() or member.isfile()):
                raise ValueError("Unexpected unsafe entry in IAM temporary directory; review privately")
            if member.isfile():
                count += 1
    return count


def archive_manifest(path):
    """Compare copied bytes and ownership without revealing filenames or data."""
    result = {}
    with tarfile.open(path) as archive:
        for member in archive:
            if not (member.isdir() or member.isfile()):
                raise ValueError("Unexpected archive entry")
            content = hashlib.sha256()
            if member.isfile():
                with archive.extractfile(member) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        content.update(block)
            result[str(PurePosixPath(member.name))] = (
                member.isdir(), member.mode, member.uid, member.gid, content.hexdigest()
            )
    return result


def discovery(container):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for network in container["NetworkSettings"]["Networks"].values():
        ip = network.get("IPAddress")
        if not ip:
            continue
        try:
            request = urllib.request.Request("http://" + ip + ":8000/.well-known/openid-configuration",
                                             headers={"Host": "iam.openlims.ai"})
            with opener.open(request, timeout=5) as response:
                data = json.load(response)
            if data.get("issuer") and data.get("token_endpoint"):
                return {key: data.get(key) for key in ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri")}
        except (OSError, ValueError):
            continue
    raise RuntimeError("IAM discovery unavailable")


def wait_ready(image, baseline):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            live = capture(["docker", "inspect", TARGET])[0]
            if live["Image"] == image and live["State"]["Running"] and discovery(live) == baseline:
                return
        except (RuntimeError, sp.SubprocessError):
            pass
        time.sleep(2)
    raise RuntimeError("IAM did not recover its discovery contract")


def seed_archive(live, archive, value):
    """Seed one new empty volume and verify bytes/metadata before replacement."""
    existing = sp.check_output(["docker", "volume", "ls", "--format", "{{.Name}}"], stderr=sp.DEVNULL).decode().splitlines()
    if value["volume"] in existing:
        raise ValueError("Target volume appeared during migration; refusing to overwrite")
    run(["docker", "volume", "create", value["volume"]])
    run(["docker", "run", "--rm", "--network", "none", "--read-only",
         "--security-opt", "no-new-privileges:true", "--user", "0:0",
         "--mount", "type=volume,source=" + value["volume"] + ",target=/destination",
         "--mount", "type=bind,source=" + str(archive) + ",target=/source.tar,readonly",
         "--entrypoint", "sh", live["Image"], "-c",
         'test -z "$(ls -A /destination)" && tar xf /source.tar -C /destination'])
    copied = archive.with_name("seeded-" + archive.name)
    with copied.open("xb") as stream:
        sp.run(["docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
                "--mount", "type=volume,source=" + value["volume"] + ",target=/source,readonly",
                "--entrypoint", "sh", live["Image"], "-c", "tar cf - -C /source ."],
               stdout=stream, stderr=sp.DEVNULL, check=True)
    if archive_manifest(archive) != archive_manifest(copied):
        raise ValueError("Seeded IAM bytes or permissions differ; original IAM restored")


def copy_and_seed(live, directory):
    """Stop once, snapshot both stores, verify both, then permit replacement."""
    try:
        run(["docker", "stop", "--time", "30", TARGET])
        receipt = {}
        for key, value in STORES.items():
            archive = directory / (key + ".private.tar")
            with archive.open("xb") as stream:
                sp.run(["docker", "cp", TARGET + ":" + value["path"] + "/.", "-"],
                       stdout=stream, stderr=sp.DEVNULL, check=True)
            receipt[key] = {"volume": value["volume"], "copied_files": validate_archive(archive),
                            "archive_sha256": digest(archive)}
        for key, value in STORES.items():
            seed_archive(live, directory / (key + ".private.tar"), value)
        return receipt
    except BaseException:
        run(["docker", "start", TARGET])
        raise


def replace_iam(command, live, baseline):
    try:
        run(command + ["up", "-d", "--no-deps", "--force-recreate", "casdoor"])
        wait_ready(live["Image"], baseline)
        return
    except (OSError, RuntimeError, sp.SubprocessError):
        # Compose can fail after removing the old container but before creating
        # its replacement. Missing inspect must not prevent same-volume recovery.
        try:
            current = capture(["docker", "inspect", TARGET])[0]
        except (OSError, sp.SubprocessError):
            current = None
        if current and current["Id"] == live["Id"]:
            run(["docker", "start", TARGET])
            wait_ready(live["Image"], baseline)
            raise RuntimeError("IAM replacement failed; original IAM restored. Backup and seeded volume retained for review.") from None
        try:
            run(command + ["up", "-d", "--no-deps", "casdoor"])
            wait_ready(live["Image"], baseline)
        except (OSError, RuntimeError, sp.SubprocessError):
            raise RuntimeError("IAM replacement/recovery failed; use recovery.private.json with the migrated volume immediately. Backup retained.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-current", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.expected_current):
        raise ValueError("Use the current immutable IAM image ID")
    live = capture(["docker", "inspect", TARGET])[0]
    if live["Image"] != args.expected_current or not live["State"]["Running"]:
        raise ValueError("IAM changed or is not running; review first")
    if live["Config"].get("WorkingDir") not in ("", "/"):
        raise ValueError("Unexpected IAM working directory; /tmp may not be the session store")
    if any(m["Destination"] in {v["path"] for v in STORES.values()} for m in live["Mounts"]):
        raise ValueError("IAM already has a session/log mount; review first")
    labels = live["Config"]["Labels"]
    if labels["com.docker.compose.service"] != "casdoor":
        raise ValueError("Unexpected Compose service")
    files = labels["com.docker.compose.project.config_files"].split(",")
    root = Path(labels["com.docker.compose.project.working_dir"])
    inputs = [*(Path(f) for f in files), root / ".env"]
    inputs += [Path(m["Source"]) for m in live["Mounts"]
               if m["Type"] == "bind" and Path(m["Source"]).is_file()]
    hashes = {str(path): digest(path) for path in inputs}
    original = ["docker", "compose", "--project-name", labels["com.docker.compose.project"],
                "--project-directory", str(root), "--env-file", str(root / ".env")]
    original += [part for file in files for part in ("-f", file)]
    before = capture(original + ["config", "--format", "json"])
    image = capture(["docker", "image", "inspect", before["services"]["casdoor"]["image"]])[0]
    if image["Id"] != live["Image"]:
        raise ValueError("Resolved IAM image differs from running image")
    config_hash = sp.check_output(original + ["config", "--hash", "casdoor"], stderr=sp.DEVNULL).decode().split()[-1]
    if config_hash != labels["com.docker.compose.config-hash"]:
        raise ValueError("Live Compose configuration drift; reconcile before migration")
    if set(v["volume"] for v in STORES.values()) & set(sp.check_output(["docker", "volume", "ls", "--format", "{{.Name}}"], stderr=sp.DEVNULL).decode().splitlines()):
        raise ValueError("Target volume already exists; never overwrite a previous migration")
    with tempfile.TemporaryDirectory(prefix="iam-session-preflight-") as directory:
        candidate = Path(directory) / "overlay.json"
        write_private(candidate, overlay(args.expected_current))
        after = capture(original + ["-f", str(candidate), "config", "--format", "json"])
    validate_delta(before, after, live, image)
    baseline = discovery(live)
    if not args.apply:
        print("Verified: same IAM image, complete live Compose chain, only persistent session and log mounts")
        return
    with ExitStack() as stack:
        for name in LOCKS:
            lock = stack.enter_context((root / name).open("a"))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = capture(["docker", "inspect", TARGET])[0]
        if current["Id"] != live["Id"] or any(digest(Path(p)) != value for p, value in hashes.items()):
            raise ValueError("IAM/Compose changed during preflight")
        args.directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        active = args.directory.resolve() / "iam.sessions.active.json"
        write_private(active, overlay(args.expected_current))
        command = original + ["-f", str(active)]
        resolved = capture(command + ["config", "--format", "json"])
        validate_delta(before, resolved, live, image)
        manifest = {"container_id": live["Id"], "image": live["Image"], "compose_files": files,
                    "input_hashes": hashes, "volumes": {k: v["volume"] for k, v in STORES.items()}, "restart_command": command + ["up", "-d", "--no-deps", "casdoor"]}
        write_private(args.directory / "recovery.private.json", manifest)
        receipt = copy_and_seed(live, args.directory.resolve())
        # Startup uses the same immutable image/config. Never roll back to an
        # empty container layer: keep the migrated volume attached on recovery.
        replace_iam(command, live, baseline)
        write_private(args.directory / "verified.json", {"image": live["Image"], "stores": receipt,
                      "oidc_discovery_unchanged": True})
    print("IAM sessions and diagnostic logs preserved; same image/discovery restored. Complete authenticated SSO acceptance separately.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, sp.SubprocessError) as error:
        # Docker/HTTP exception output can contain private configuration.
        if isinstance(error, (ValueError, RuntimeError)):
            raise SystemExit(str(error)) from None
        raise SystemExit("Migration failed safely; inspect private artifacts and current IAM status") from None
