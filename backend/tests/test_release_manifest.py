"""Release records identify the deployed containers without retaining credentials."""

import copy
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "deploy/security/release.py"
spec = importlib.util.spec_from_file_location("release_manifest", SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

OLD_IMAGE = "sha256:" + "1" * 64
NEW_IMAGE = "sha256:" + "2" * 64
DATABASE = "postgresql://user:db-secret@private-host/db"
PROTECTED_ENV = {
    "DATABASE_URL": DATABASE,
    "APP_SECRET": "app-secret",
    "CASDOOR_CLIENT_SECRET": "iam-secret",
    "SOLUTION_KB_TOKEN": "knowledge-secret",
    "SOLUTION_KB_CORE_URL": "http://private-knowledge-core",
    "SOLUTION_KB_PUBLIC_URL": "https://private-knowledge-public",
    "AUTO_MIGRATE_SCHEMA": "false",
    "AUTO_SEED": "false",
    "AI_ALLOWED_INTERNAL_ORIGINS": "http://127.0.0.1:11434",
}


@pytest.mark.parametrize("wrong_image", [False, True])
def test_release_records_only_verified_deployment_and_rolls_back_worker(
    tmp_path, monkeypatch, wrong_image
):
    root = tmp_path / "production"
    root.mkdir()
    backup = root / "backups"
    backup.mkdir()
    first = root / "compose.yml"
    last = root / "worker.private.yml"
    candidate = root / "security.yml"
    for path in (first, last, candidate, root / ".env"):
        path.write_text("")
    runtime = root / "runtime.env"
    runtime.write_text(f"PMS_RUNTIME_DATABASE_URL={DATABASE}")
    runtime.chmod(0o600)

    release_targets = (*release.SERVICES, "worker")
    labels = {
        "com.docker.compose.project.config_files": f"{first},{last}",
        "com.docker.compose.project.working_dir": str(root),
        "com.docker.compose.project": "synthetic",
    }
    config = {"services": {}, "volumes": {"ai": {"name": "synthetic_ai"}}}
    containers = {}
    names = (*release.TARGETS, "synthetic-worker-1")
    for name, target in zip(names, release_targets):
        env = {
            **PROTECTED_ENV,
            "APP_PROCESS_ROLE": "worker" if target == "worker" else "web",
            "ASSISTANT_REQUEST_WORKER_ENABLED": "true",
        }
        config["services"][target] = {
            "image": OLD_IMAGE,
            "environment": env,
            "user": "10001:10001",
            "read_only": True,
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "command": ["secret-command-argument"],
            "volumes": [
                {"type": "volume", "source": "ai", "target": "/data/ai"},
                {"type": "bind", "source": "/private/secret-bind-path", "target": "/data/key"},
            ],
        }
        containers[name] = {
            "Name": f"/{name}",
            "Id": name,
            "Image": OLD_IMAGE,
            "State": {"Running": True},
            "Config": {
                "Labels": {**labels, "com.docker.compose.service": target},
                "Env": [f"{key}={value}" for key, value in env.items()],
            },
        }

    def capture(command):
        if command[:2] == ["docker", "inspect"]:
            return [copy.deepcopy(containers[name]) for name in command[2:]]
        if command[:3] == ["docker", "image", "inspect"]:
            return [
                {
                    "Id": image,
                    "Config": {
                        "Labels": {"org.opencontainers.image.revision": letter * 40},
                        "Env": ["PRIVATE_IMAGE_VALUE=secret-image-env"],
                    },
                }
                for image, letter in ((OLD_IMAGE, "a"), (NEW_IMAGE, "b"))
            ]
        rendered = copy.deepcopy(config)
        if str(candidate) in command:
            for name in release.SERVICES:
                rendered["services"][name]["image"] = NEW_IMAGE
        if str(candidate.with_suffix(".active.yml")) in command:
            for name in release_targets:
                rendered["services"][name]["image"] = NEW_IMAGE
        return rendered

    rollout_commands = []

    def run(command, check):
        if command[:2] == ["docker", "run"]:
            return
        assert command[-3:] == list(release_targets)
        rollout_commands.append(command)
        rollback = str(candidate.with_suffix(".rollback.compose.json")) in command
        for name, item in containers.items():
            item["Image"] = (
                OLD_IMAGE if rollback or (wrong_image and name == names[-1]) else NEW_IMAGE
            )

    # Release reads and overwrites two environment values; restore them after this test.
    monkeypatch.setenv("PMS_RUNTIME_DATABASE_URL", "")
    monkeypatch.setenv("SECURITY_PM_IMAGE", "")
    monkeypatch.setattr(release, "capture", capture)
    monkeypatch.setattr(release.sp, "run", run)
    monkeypatch.setattr(release.sp, "check_output", lambda *args, **kwargs: names[-1] + "\n")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "release",
            "--expected-current",
            OLD_IMAGE,
            "--image",
            NEW_IMAGE,
            "--runtime-env",
            str(runtime),
            "--overlay",
            str(candidate),
            "--backup-directory",
            str(backup),
            "--apply",
        ],
    )
    previous_umask = os.umask(0o077)
    try:
        if wrong_image:
            with pytest.raises(RuntimeError, match="previous services restored"):
                release.main()
        else:
            release.main()
    finally:
        os.umask(previous_umask)

    manifest = candidate.with_suffix(".manifest.json")
    if wrong_image:
        assert len(rollout_commands) == 2
        assert not manifest.exists()
        assert all(item["Image"] == OLD_IMAGE for item in containers.values())
        return
    assert len(rollout_commands) == 1
    assert manifest.stat().st_mode & 0o777 == 0o600
    encoded = manifest.read_text()
    assert not any(
        secret in encoded
        for secret in (
            *(set(PROTECTED_ENV.values()) - {"true", "false"}),
            "secret-bind-path",
            "secret-command-argument",
            "secret-image-env",
            str(root),
        )
    )
    data = json.loads(encoded)
    assert data["status"] == "deployed"
    assert data["source_revision"] == "b" * 40
    assert data["verified_image_ids"] == dict.fromkeys(release_targets, NEW_IMAGE)
    assert data["ordered_compose_files"] == [
        "compose.yml",
        "worker.private.yml",
        "security.active.yml",
    ]
    assert data["configured_services"]["worker"]["process_role"] == "worker"
    assert data["configured_services"]["worker"]["mounts"][0]["volume"] == "synthetic_ai"
    assert data["rollback"]["image_id"] == OLD_IMAGE


def test_active_overlay_resolves_without_duplicate_security_options(tmp_path, monkeypatch):
    docker = shutil.which("docker")
    if not docker or subprocess.run([docker, "compose", "version"], capture_output=True).returncode:
        pytest.skip("Docker Compose is required to verify overlay resolution")

    security = SCRIPT.with_name("compose.security.yml")
    current = tmp_path / "current.yml"
    current.write_text(security.read_text())
    active = tmp_path / "active.yml"
    monkeypatch.setenv("SECURITY_PM_IMAGE", NEW_IMAGE)
    monkeypatch.setenv("PMS_RUNTIME_DATABASE_URL", DATABASE)
    prefix = [docker, "compose", "-p", "release-test", "-f", str(current)]

    def resolve(overlay):
        return json.loads(
            subprocess.check_output(prefix + ["-f", str(overlay), "config", "--format", "json"])
        )

    candidate = resolve(security)
    active.write_text(release.active_overlay(candidate, NEW_IMAGE))
    assert resolve(active)["services"] == candidate["services"]
    assert candidate["services"]["app"]["security_opt"] == ["no-new-privileges:true"]
