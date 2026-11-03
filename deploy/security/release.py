#!/usr/bin/env python3
"""Guarded PM rollout: preserve live overlays and settings; rollback failed starts."""

import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess as sp

TARGETS = ["mb-pm-v2-app-1", "mb-pm-v2-app-direct-1"]
SERVICES = ("app", "app-direct")
CHANGED_ENV = {
    "DATABASE_URL",
    "AUTO_MIGRATE_SCHEMA",
    "AUTO_SEED",
    "AI_ALLOWED_INTERNAL_ORIGINS",
}
HARDENING_FIELDS = (
    "user",
    "cap_drop",
    "security_opt",
    "read_only",
    "tmpfs",
    "mem_limit",
    "memswap_limit",
    "cpus",
    "pids_limit",
    "logging",
)


def capture(args):
    return json.loads(sp.check_output(args))


def env_map(values):
    return dict(item.split("=", 1) for item in values or [] if "=" in item)


def compose_env(values):
    """Compose config re-escapes $ as $$ for safe serialization; compare runtime values."""
    return {
        key: value.replace("$$", "$") if isinstance(value, str) else value
        for key, value in values.items()
    }


def private_text(path, encoded):
    if path.exists():
        if path.stat().st_mode & 0o077 or path.read_text() != encoded:
            raise SystemExit(
                "Existing private release artifact differs; use a new release directory"
            )
        return
    with path.open("x") as output:
        output.write(encoded)


def private_json(path, value):
    private_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def active_overlay(after, image):
    # JSON is a valid YAML value; only ports needs the Compose YAML !override tag.
    # Values from `compose config` are already escaped for safe serialization.
    lines = ["services:"]
    for service in SERVICES:
        new = after["services"][service]
        value = {key: new[key] for key in HARDENING_FIELDS if key in new}
        value.update(
            image=image,
            environment={key: new["environment"][key] for key in CHANGED_ENV},
        )
        lines.append("  " + service + ": " + json.dumps(value, ensure_ascii=False))
    proxy = after["services"].get("direct-proxy")
    if proxy:
        lines.append("  direct-proxy:")
        for key in (
            "image",
            "ports",
            "mem_limit",
            "memswap_limit",
            "pids_limit",
            "logging",
        ):
            tag = "!override " if key == "ports" else ""
            lines.append(
                "    " + key + ": " + tag + json.dumps(proxy[key], ensure_ascii=False)
            )
    return "\n".join(lines) + "\n"


def validate_portal_configuration(live_env, effective, service):
    """Independent portal credentials are optional per instance, never optional to preserve."""
    required = ("PORTAL_PUBLIC_URL", "PORTAL_CLIENT_ID", "PORTAL_CLIENT_SECRET")
    portal_keys = {
        key for key in live_env.keys() | effective.keys() if key.startswith("PORTAL_")
    }
    for key in portal_keys:
        if (key in live_env, live_env.get(key)) != (
            key in effective,
            effective.get(key),
        ):
            raise SystemExit(
                "Live portal configuration would be added, lost or changed: "
                + service
                + "/"
                + key
            )
    present = [bool(live_env.get(key, "").strip()) for key in required]
    if any(present) and not all(present):
        raise SystemExit(
            "Existing independent portal configuration is incomplete: " + service
        )


def validate_configs(before, after, containers, old_image_env, new_image_env, image):
    for service in SERVICES:
        old, new = before["services"][service], after["services"][service]
        for field in (
            "volumes",
            "networks",
            "command",
            "ports",
            "entrypoint",
            "healthcheck",
        ):
            if old.get(field) != new.get(field):
                raise SystemExit(
                    "Unexpected topology/startup change: " + service + "/" + field
                )
        for key, value in old.get("environment", {}).items():
            if key not in CHANGED_ENV and new.get("environment", {}).get(key) != value:
                raise SystemExit(
                    "Unexpected configuration change: " + service + "/" + key
                )
        live = next(
            item
            for item in containers
            if item["Config"]["Labels"]["com.docker.compose.service"] == service
        )
        live_env = env_map(live["Config"]["Env"])
        effective = {**new_image_env, **compose_env(new.get("environment", {}))}
        validate_portal_configuration(live_env, effective, service)
        for key, value in live_env.items():
            if key in CHANGED_ENV:
                continue
            # Image-build defaults (PATH/Python version etc.) may legitimately change.
            if (
                key not in old.get("environment", {})
                and old_image_env.get(key) == value
            ):
                continue
            if effective.get(key) != value:
                raise SystemExit(
                    "Live setting would be lost or changed: " + service + "/" + key
                )
        for key in (
            "APP_SECRET",
            "CASDOOR_CLIENT_SECRET",
            "SOLUTION_KB_TOKEN",
            "SOLUTION_KB_CORE_URL",
            "SOLUTION_KB_PUBLIC_URL",
        ):
            if not live_env.get(key) or effective.get(key) != live_env[key]:
                raise SystemExit(
                    "Required live identity/knowledge setting missing or changed: "
                    + key
                )
        if (
            new["image"] != image
            or new.get("user") != "10001:10001"
            or not new.get("read_only")
        ):
            raise SystemExit("Runtime hardening not applied")
        if "ALL" not in new.get(
            "cap_drop", []
        ) or "no-new-privileges:true" not in new.get("security_opt", []):
            raise SystemExit("Runtime capability restrictions not applied")

    old_proxy, new_proxy = (
        before["services"].get("direct-proxy"),
        after["services"].get("direct-proxy"),
    )
    if old_proxy:
        if not new_proxy:
            raise SystemExit("Existing maintenance proxy disappeared")
        for field in ("volumes", "networks", "command", "entrypoint", "environment"):
            if old_proxy.get(field) != new_proxy.get(field):
                raise SystemExit(
                    "Unexpected maintenance proxy configuration change: " + field
                )
        ports = new_proxy.get("ports", [])
        if len(ports) != 2 or {
            (
                port.get("host_ip"),
                str(port.get("published")),
                port.get("target"),
                port.get("protocol", "tcp"),
            )
            for port in ports
        } != {("127.0.0.1", "8443", 8443, "tcp"), ("127.0.0.1", "18443", 18443, "tcp")}:
            raise SystemExit(
                "Maintenance proxy must bind only the two approved loopback ports"
            )
        if not re.fullmatch(r"caddy@sha256:[a-f0-9]{64}", new_proxy.get("image", "")):
            raise SystemExit("Maintenance proxy image must be immutable")


def rollout(command, rollback_command):
    options = ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", *SERVICES]
    try:
        sp.run(command + options, check=True)
    except BaseException:
        print(
            "New services failed health/startup; restoring the previous immutable images",
            flush=True,
        )
        try:
            sp.run(rollback_command + options, check=True)
        except BaseException as rollback_error:
            raise RuntimeError(
                "Deployment and automatic rollback failed; use the protected rollback manifest immediately"
            ) from rollback_error
        raise RuntimeError("Deployment failed; previous services restored") from None


@contextmanager
def release_locks(root, backup_directory):
    """Use the scheduler's lock order and hold it through rollout and rollback."""
    if backup_directory.is_symlink() or not backup_directory.is_dir():
        raise SystemExit(
            "Existing backup directory required; do not create a new lock domain"
        )
    with ExitStack() as stack:
        directory_fd = os.open(
            backup_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        stack.callback(os.close, directory_fd)
        for name, parent_fd in (
            (".daily-backup.lock", directory_fd),
            (".backup.lock", directory_fd),
            (str(root / ".security-release.lock"), None),
        ):
            fd = os.open(
                name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd
            )
            handle = stack.enter_context(os.fdopen(fd, "a"))
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise SystemExit("Release locks must be regular files")
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--expected-current", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--runtime-env", type=Path, required=True)
    p.add_argument("--overlay", type=Path, required=True)
    p.add_argument(
        "--backup-directory",
        type=Path,
        default=Path.home() / "backups" / "daily",
        help="Existing directory used by daily_backup.py and backup.py",
    )
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    os.umask(0o077)
    if not all(
        re.fullmatch(r"sha256:[a-f0-9]{64}", value)
        for value in (args.expected_current, args.image)
    ):
        raise SystemExit("Use immutable sha256 image IDs")
    if args.runtime_env.stat().st_mode & 0o077:
        raise SystemExit("Runtime credentials must have mode 0600")
    runtime_bytes = args.runtime_env.read_bytes()
    env_text = runtime_bytes.decode().strip()
    if not env_text.startswith("PMS_RUNTIME_DATABASE_URL=") or "\n" in env_text:
        raise SystemExit("Expected a single private runtime database setting")
    runtime_url = env_text.split("=", 1)[1]
    containers = capture(["docker", "inspect", *TARGETS])
    baseline = containers[0]["Config"]["Labels"]
    files = baseline["com.docker.compose.project.config_files"].split(",")
    root = Path(baseline["com.docker.compose.project.working_dir"])
    project = baseline["com.docker.compose.project"]
    for item in containers:
        labels = item["Config"]["Labels"]
        if item["Image"] != args.expected_current:
            raise SystemExit("Live image changed; re-review before deployment")
        if any(
            labels[key] != baseline[key]
            for key in (
                "com.docker.compose.project.config_files",
                "com.docker.compose.project.working_dir",
                "com.docker.compose.project",
            )
        ):
            raise SystemExit(
                "Instances have different deployment origins; resolve before deployment"
            )
    if not all(Path(path).is_file() for path in files):
        raise SystemExit("A live Compose overlay is missing")
    input_hashes = {
        path: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in {*(Path(path) for path in files), root / ".env", args.overlay}
    }
    input_hashes[args.runtime_env] = hashlib.sha256(runtime_bytes).hexdigest()
    prefix = [
        "docker",
        "compose",
        "--project-name",
        project,
        "--project-directory",
        str(root),
        "--env-file",
        str(root / ".env"),
    ]
    original = prefix + [part for file in files for part in ("-f", file)]
    os.environ["PMS_RUNTIME_DATABASE_URL"] = runtime_url
    os.environ["SECURITY_PM_IMAGE"] = args.expected_current
    before = capture(original + ["config", "--format", "json"])
    os.environ["SECURITY_PM_IMAGE"] = args.image
    after = capture(
        original + ["-f", str(args.overlay.resolve()), "config", "--format", "json"]
    )
    image_info = capture(
        ["docker", "image", "inspect", args.expected_current, args.image]
    )
    validate_configs(
        before,
        after,
        containers,
        env_map(image_info[0]["Config"].get("Env")),
        env_map(image_info[1]["Config"].get("Env")),
        args.image,
    )
    # Non-mutating probe: root-owned 0600 AI files must be migrated explicitly
    # before changing container UID, rather than discovering it after publication.
    for target in TARGETS:
        sp.run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--user",
                "10001:10001",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--volumes-from",
                target,
                "--entrypoint",
                "sh",
                args.image,
                "-c",
                'for d in /data/ai /data/information; do test -d "$d" && test -r "$d" && test -w "$d" && test -x "$d" || exit 1; done; if test -e /data/ai/ai-settings.json; then test -r /data/ai/ai-settings.json || exit 1; fi',
            ],
            check=True,
        )
    if not args.apply:
        print(
            "Plan verified: live settings, exact overlays, volumes, networks and non-root access preserved"
        )
        return
    with release_locks(root, args.backup_directory):
        current = capture(["docker", "inspect", *TARGETS])
        if len(current) != len(containers) or any(
            live["Id"] != baseline["Id"] or live["Image"] != args.expected_current
            for live, baseline in zip(current, containers)
        ):
            raise SystemExit("Live container or image changed during preflight")
        if any(
            hashlib.sha256(path.read_bytes()).hexdigest() != expected
            for path, expected in input_hashes.items()
        ):
            raise SystemExit("Compose or environment input changed during preflight")
        # Persist a concrete private LAST overlay. No future Compose invocation
        # depends on this process's environment or on a forgotten --env-file.
        active = args.overlay.with_suffix(".active.yml").resolve()
        private_text(active, active_overlay(after, args.image))
        resolved = capture(original + ["-f", str(active), "config", "--format", "json"])
        if resolved["services"] != after["services"]:
            raise SystemExit(
                "Fixed deployment overlay differs from reviewed configuration"
            )
        rollback = args.overlay.with_suffix(".rollback.compose.json").resolve()
        # Original Compose files remain intact; an image-only final override
        # restores the old settings without duplicating their secret values.
        previous = {
            "services": {
                service: {"image": args.expected_current} for service in SERVICES
            }
        }
        private_json(rollback, previous)
        rollback_command = original + ["-f", str(rollback)]
        private_json(
            args.overlay.with_suffix(".rollback.json"),
            {
                "image": args.expected_current,
                "files": files,
                "project": project,
                "rollback_command": rollback_command,
            },
        )
        rollout(original + ["-f", str(active)], rollback_command)
    print(
        "Target services healthy; perform real identity and application acceptance next"
    )


if __name__ == "__main__":
    main()
