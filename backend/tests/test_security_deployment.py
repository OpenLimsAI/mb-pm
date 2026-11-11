"""Offline deployment safety checks: never contact Docker or a production service."""

import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


def load_script(name):
    path = Path(__file__).resolve().parents[2] / "deploy" / "security" / (name + ".py")
    spec = importlib.util.spec_from_file_location("security_" + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_script("release")
backup = load_script("backup")


def release_data():
    environment = {
        key: "synthetic-" + key
        for key in (
            "APP_SECRET",
            "CASDOOR_CLIENT_SECRET",
            "PORTAL_PUBLIC_URL",
            "PORTAL_CLIENT_ID",
            "PORTAL_CLIENT_SECRET",
            "SOLUTION_KB_TOKEN",
            "SOLUTION_KB_CORE_URL",
            "SOLUTION_KB_PUBLIC_URL",
        )
    }
    environment["CUSTOM_PRIVATE_SETTING"] = "must-preserve"
    old = {"environment": environment, "volumes": [{"source": "papers", "target": "/data"}]}
    before = {"services": {name: copy.deepcopy(old) for name in release.SERVICES}}
    after = copy.deepcopy(before)
    for svc in after["services"].values():
        svc.update(
            image="fixed-image",
            user="10001:10001",
            read_only=True,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges:true"],
        )
    containers = [
        {
            "Config": {
                "Labels": {"com.docker.compose.service": name},
                "Env": [key + "=" + value for key, value in environment.items()],
            }
        }
        for name in release.SERVICES
    ]
    return before, after, containers


def mixed_portal_release_data():
    """The normal instance hosts an independent portal; emergency PM reuses PM IAM."""
    before, after, containers = release_data()
    for config in (before, after):
        env = config["services"]["app-direct"]["environment"]
        for key in list(env):
            if key.startswith("PORTAL_"):
                del env[key]
    containers[1]["Config"]["Env"] = [
        value for value in containers[1]["Config"]["Env"] if not value.startswith("PORTAL_")
    ]
    return before, after, containers


def test_release_accepts_independent_portal_and_pm_only_emergency_instance():
    before, after, containers = mixed_portal_release_data()
    release.validate_configs(before, after, containers, {}, {}, "fixed-image")
    assert "PORTAL_CLIENT_SECRET" not in after["services"]["app-direct"]["environment"]


@pytest.mark.parametrize("key", ["PORTAL_PUBLIC_URL", "PORTAL_CLIENT_ID", "PORTAL_CLIENT_SECRET"])
def test_release_rejects_losing_an_enabled_portal_setting(key):
    before, after, containers = mixed_portal_release_data()
    after["services"]["app"]["environment"].pop(key)
    with pytest.raises(SystemExit):
        release.validate_configs(before, after, containers, {}, {}, "fixed-image")


@pytest.mark.parametrize(
    "added",
    [
        {"PORTAL_CLIENT_SECRET": "unreviewed"},
        {
            "PORTAL_PUBLIC_URL": "https://synthetic.invalid",
            "PORTAL_CLIENT_ID": "unreviewed",
            "PORTAL_CLIENT_SECRET": "unreviewed",
        },
        {"PORTAL_JWKS_URL": "https://synthetic.invalid/jwks"},
        {"PORTAL_CLIENT_SECRET": ""},
    ],
)
def test_release_rejects_silently_enabling_or_adding_portal_config_to_emergency_instance(added):
    before, after, containers = mixed_portal_release_data()
    after["services"]["app-direct"]["environment"].update(added)
    with pytest.raises(SystemExit, match="portal configuration would be added"):
        release.validate_configs(before, after, containers, {}, {}, "fixed-image")


@pytest.mark.parametrize(
    "remaining", ["PORTAL_PUBLIC_URL", "PORTAL_CLIENT_ID", "PORTAL_CLIENT_SECRET"]
)
def test_release_rejects_preexisting_partial_portal_config(remaining):
    before, after, containers = mixed_portal_release_data()
    value = "synthetic-" + remaining
    for config in (before, after):
        config["services"]["app-direct"]["environment"][remaining] = value
    containers[1]["Config"]["Env"].append(remaining + "=" + value)
    with pytest.raises(SystemExit, match="independent portal configuration is incomplete"):
        release.validate_configs(before, after, containers, {}, {}, "fixed-image")


def test_release_rejects_image_default_changing_live_portal_secret():
    before, after, containers = mixed_portal_release_data()
    # Previously inherited values are still security configuration, not disposable build defaults.
    for config in (before, after):
        config["services"]["app"]["environment"].pop("PORTAL_CLIENT_SECRET")
    with pytest.raises(SystemExit, match="portal configuration would be added, lost or changed"):
        release.validate_configs(
            before,
            after,
            containers,
            {"PORTAL_CLIENT_SECRET": "synthetic-PORTAL_CLIENT_SECRET"},
            {"PORTAL_CLIENT_SECRET": "replacement"},
            "fixed-image",
        )


def test_release_preserves_all_live_settings_not_only_known_secrets():
    before, after, containers = release_data()
    release.validate_configs(before, after, containers, {}, {}, "fixed-image")
    after["services"]["app"]["environment"].pop("CUSTOM_PRIVATE_SETTING")
    with pytest.raises(SystemExit, match="configuration change"):
        release.validate_configs(before, after, containers, {}, {}, "fixed-image")
    before, after, containers = release_data()
    for container in containers:
        container["Config"]["Env"].append("MANUAL_RUNTIME_SETTING=preserve-too")
    with pytest.raises(SystemExit, match="Live setting would be lost"):
        release.validate_configs(before, after, containers, {}, {}, "fixed-image")


def test_release_preserves_topology_and_permits_image_build_defaults_only():
    before, after, containers = release_data()
    containers[0]["Config"]["Env"].append("PYTHON_VERSION=old-version")
    release.validate_configs(
        before,
        after,
        containers,
        {"PYTHON_VERSION": "old-version"},
        {"PYTHON_VERSION": "new-version"},
        "fixed-image",
    )
    after["services"]["app"]["volumes"] = []
    with pytest.raises(SystemExit, match="topology"):
        release.validate_configs(before, after, containers, {}, {}, "fixed-image")


def test_compose_serialization_is_decoded_for_live_environment_comparison():
    before, after, containers = release_data()
    for config in (before, after):
        for service in config["services"].values():
            service["environment"]["APP_SECRET"] = "$${OTHER}$$suffix$$$$"
    for container in containers:
        container["Config"]["Env"] = [
            "APP_SECRET=${OTHER}$suffix$$" if item.startswith("APP_SECRET=") else item
            for item in container["Config"]["Env"]
        ]
    release.validate_configs(before, after, containers, {}, {}, "fixed-image")
    assert after["services"]["app"]["environment"]["APP_SECRET"] == "$${OTHER}$$suffix$$$$"


def test_failed_release_automatically_rolls_back(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if len(calls) == 1:
            raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(release.sp, "run", run)
    with pytest.raises(RuntimeError, match="previous services restored"):
        release.rollout(["new"], ["old"])
    assert [call[0] for call in calls] == ["new", "old"]
    assert calls[1][-2:] == ["app", "app-direct"]


def test_failed_rollback_is_explicit(monkeypatch):
    def run(command, **kwargs):
        raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(release.sp, "run", run)
    with pytest.raises(RuntimeError, match="automatic rollback failed"):
        release.rollout(["new"], ["old"])


def test_backup_rejects_recursive_ancestor_and_outside_home(tmp_path):
    home = tmp_path / "home"
    backup_dir = home / "backups" / "encrypted"
    backup_dir.mkdir(parents=True)
    allowed = home / "specific.env"
    allowed.write_text("synthetic only")
    assert backup.validate_include(allowed, backup_dir, home) == allowed
    for path in (home, home / "backups", backup_dir, tmp_path):
        with pytest.raises(SystemExit, match="cannot contain"):
            backup.validate_include(path, backup_dir, home)


def test_backup_covers_core_and_shared_volumes_once():
    core = {"Type": "bind", "Source": "/home/test/core/base", "Destination": "/base"}
    shared = {"Type": "volume", "Source": "/volumes/shared", "Destination": "/data/ai"}
    ephemeral = {"Type": "tmpfs", "Destination": "/tmp"}
    info = {
        "core": {"Mounts": [core]},
        "pm": {"Mounts": [shared, ephemeral]},
        "pm-direct": {"Mounts": [shared]},
    }
    found = backup.collect_mounts(list(info), info)
    assert len(found) == 2
    assert ("core", core) in found.values()
    info["core"]["Mounts"][0] = dict(core, Destination="/")
    with pytest.raises(SystemExit, match="unrestricted root"):
        backup.collect_mounts(list(info), info)


@pytest.mark.parametrize("split_workers", [False, True])
def test_backup_restarts_all_originally_running_writers_after_dump_failure(
    monkeypatch, tmp_path, split_workers
):
    key = tmp_path / "key"
    key.write_text("not-a-real-key")
    key.chmod(0o600)
    writers = ([backup.PM_WORKER] if split_workers else []) + backup.WRITERS
    items = {
        name: {
            "Name": "/" + name,
            "Config": {"Env": ["POSTGRES_USER=synthetic"], "Labels": {}},
            "State": {"Running": True},
            "Mounts": [],
        }
        for name in [*writers, *backup.DATABASES]
    }
    items["dikw-web"]["State"]["Running"] = False  # Preserve an intentionally stopped service.
    monkeypatch.setattr(
        sys,
        "argv",
        ["backup", "--directory", str(tmp_path / "backups"), "--key", str(key), "--quiesce"],
    )
    monkeypatch.setattr(
        backup.shutil, "disk_usage", lambda path: type("Disk", (), {"free": 10 * 1024**3})()
    )

    def inspect(command):
        if command[:2] == ["docker", "ps"]:
            assert f"name=^/{backup.PM_WORKER}$" in command
            return (backup.PM_WORKER + "\n").encode() if split_workers else b""
        assert command[:2] == ["docker", "inspect"]
        return json.dumps([items[name] for name in command[2:]]).encode()

    monkeypatch.setattr(backup.sp, "check_output", inspect)
    restarted = []

    def run(command, **kwargs):
        if command[:2] == ["docker", "stop"]:
            items[command[-1]]["State"]["Running"] = False
        elif command[:2] == ["docker", "start"]:
            items[command[-1]]["State"]["Running"] = True
            restarted.append(command[-1])
        elif "pg_dump" in command:
            raise subprocess.CalledProcessError(1, command)
        else:
            pytest.fail("Unexpected command " + repr(command))

    monkeypatch.setattr(backup, "run", run)
    with pytest.raises(subprocess.CalledProcessError):
        backup.main()
    assert restarted == list(reversed([name for name in writers if name != "dikw-web"]))
    assert not items["dikw-web"]["State"]["Running"]
    assert not list((tmp_path / "backups").glob("*.gpg"))
    assert not list((tmp_path / "backups").glob("backup-stage-*"))


def test_writer_restart_requires_health_not_just_start(monkeypatch):
    info = {"app": {"State": {"Running": True, "Health": {"Status": "healthy"}}}}
    monkeypatch.setattr(
        backup.sp,
        "check_output",
        lambda command: json.dumps(
            [{"Name": "/app", "State": {"Running": True, "Health": {"Status": "unhealthy"}}}]
        ).encode(),
    )
    with pytest.raises(RuntimeError, match="did not recover healthy: app"):
        backup.wait_for_writers(["app"], info, timeout=0)


def test_active_overlay_persists_maintenance_port_override_and_fixed_settings():
    before, after, containers = release_data()
    before["services"]["direct-proxy"] = {"image": "caddy:old", "ports": []}
    proxy = {
        "image": "caddy@sha256:" + "a" * 64,
        "ports": [
            {"host_ip": "127.0.0.1", "published": str(port), "target": port, "protocol": "tcp"}
            for port in (8443, 18443)
        ],
        "mem_limit": 256 * 1024**2,
        "memswap_limit": 256 * 1024**2,
        "pids_limit": 64,
        "logging": {"driver": "json-file"},
    }
    after["services"]["direct-proxy"] = proxy
    for name in release.SERVICES:
        after["services"][name]["environment"].update(
            {key: "synthetic" for key in release.CHANGED_ENV}
        )
    release.validate_configs(before, after, containers, {}, {}, "fixed-image")
    result = release.active_overlay(after, "fixed-image")
    assert "ports: !override " in result
    assert '"host_ip": "127.0.0.1"' in result
    assert 'image: "caddy@sha256:' in result
    proxy["ports"].append({"target": 8443, "published": "8443"})
    with pytest.raises(SystemExit, match="only the two approved loopback"):
        release.validate_configs(before, after, containers, {}, {}, "fixed-image")
