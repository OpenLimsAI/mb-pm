"""Disk-backed business data must stay on declared, shared Compose volumes."""

from pathlib import Path, PurePosixPath

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def compose(path):
    return yaml.safe_load((ROOT / path).read_text())


def data_volumes(service):
    result = {}
    for setting in ("AI_SETTINGS_PATH", "INFORMATION_DATA_DIR"):
        target = PurePosixPath(service["environment"][setting])
        assert target.is_absolute(), setting + " must not fall back to the container layer"
        mounts = []
        for mount in service.get("volumes", []):
            if not isinstance(mount, str):
                continue
            source, destination, *options = mount.split(":")
            if target == PurePosixPath(destination) or PurePosixPath(destination) in target.parents:
                assert "ro" not in options, setting + " requires writable business storage"
                assert "/" not in source and not source.startswith("."), "use a named volume"
                mounts.append(source)
        assert len(mounts) == 1, setting + " must be covered by exactly one persistent volume"
        result[setting] = mounts[0]
    return result


@pytest.mark.parametrize("path,service", [
    ("docker-compose.yml", "app"),
    ("backend/docker-compose.yml", "backend"),
    ("deploy/parallel-test/compose.yml", "app"),
])
def test_all_container_entrypoints_persist_settings_and_originals(path, service):
    document = compose(path)
    for volume in data_volumes(document["services"][service]).values():
        assert volume in document["volumes"]
        # A second project must never accidentally use the production data volume.
        assert not (document["volumes"][volume] or {}).get("name")


def test_direct_and_domain_instances_share_the_same_business_volumes():
    base = compose("deploy/parallel-test/compose.yml")
    direct = compose("deploy/parallel-test/compose.direct.yml")
    assert data_volumes(base["services"]["app"]) == data_volumes(direct["services"]["app-direct"])
    assert data_volumes(base["services"]["app"]) == {
        "AI_SETTINGS_PATH": "ai_settings",
        "INFORMATION_DATA_DIR": "information_originals",
    }


def test_guard_rejects_a_configured_path_outside_the_persisted_volume():
    service = compose("docker-compose.yml")["services"]["app"]
    service["environment"]["INFORMATION_DATA_DIR"] = "/code/.local/information"
    with pytest.raises(AssertionError, match="exactly one persistent volume"):
        data_volumes(service)
