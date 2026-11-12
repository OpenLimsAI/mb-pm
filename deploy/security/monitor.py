#!/usr/bin/env python3
"""Server-local health/capacity evidence; no external notification credentials required."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import subprocess as sp
import tempfile

# MiB / PIDs / CPUs. Only named production services; never unknown candidate containers.
PM_WORKER = "mb-pm-v2-worker-1"
PM_WEB = {"mb-pm-v2-app-1", "mb-pm-v2-app-direct-1"}
LIMITS = {
    "mb-pm-v2-app-1": (1536, 128, 2), "mb-pm-v2-app-direct-1": (1536, 128, 2),
    PM_WORKER: (1536, 128, 2),
    "mb-pm-v2-pms-db-1": (2048, 256, 2), "mb-pm-v2-iam-db-1": (1024, 256, 2),
    "mb-pm-v2-casdoor-1": (2048, 256, 2), "mb-pm-v2-tunnel-1": (256, 128, 1),
    "mb-pm-v2-direct-proxy-1": (256, 128, 1), "iam-proxy": (256, 128, 1),
    "dikw-mbweb": (1536, 256, 2), "dikw-web": (1536, 256, 2),
    "dikw-core": (4096, 512, 4), "dikw-postgres": (3072, 256, 2), "dikw-caddy": (256, 128, 1),
    "cmab-mdm-maibo-web-1": (512, 128, 1), "cmab-mdm-maibo-backend-1": (2048, 256, 2),
    "cmab-mdm-maibo-postgres-1": (1536, 256, 2), "cmab-mdm-maibo-redis-1": (512, 128, 1),
}


def resource_limits(config, name):
    memory, pids, cpus = LIMITS[name]
    cpu_limit = config.get("NanoCpus", 0) / 1_000_000_000
    if not cpu_limit:
        cpu_limit = config.get("CpuQuota", 0) / (config.get("CpuPeriod") or 100_000)
    return (
        0 < config.get("Memory", 0) <= memory * 1024**2
        and 0 < config.get("MemorySwap", 0) <= memory * 1024**2
        and 0 < (config.get("PidsLimit") or 0) <= pids
        and 0 < cpu_limit <= cpus
    )


def log_rotation(config):
    driver = config.get("Type")
    if driver not in ("json-file", "local"):
        return False  # Remote/daemon retention cannot be verified from this config.
    options = config.get("Config", {})
    size = options.get("max-size", "20m" if driver == "local" else "-1")
    files = options.get("max-file", "5" if driver == "local" else "1")
    return bool(re.fullmatch(r"[1-9][0-9]*[kmg]?", str(size), re.IGNORECASE)
                and re.fullmatch(r"[1-9][0-9]*", str(files)))


def casdoor_sessions_persistent(item):
    """The deployed file provider uses ./tmp from WORKDIR=/, outside its SQL DB."""
    if item.get("Config", {}).get("WorkingDir", "/") not in ("", "/"):
        return False
    return any(mount.get("Destination") == "/tmp"
               and mount.get("Type") in ("volume", "bind")
               and mount.get("RW") is True
               for mount in item.get("Mounts", []))


def casdoor_logs_persistent(item):
    return any(mount.get("Destination") == "/logs"
               and mount.get("Type") in ("volume", "bind")
               and mount.get("RW") is True
               for mount in item.get("Mounts", []))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--backup-directory", type=Path, required=True)
    p.add_argument("--apply-limits", action="store_true")
    args = p.parse_args()
    os.umask(0o077)
    report = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "alerts": [], "containers": []}
    try:
        names = sp.check_output(["docker", "ps", "--all", "--format", "{{.Names}}"], stderr=sp.DEVNULL, timeout=15).decode().splitlines()
        managed = [name for name in LIMITS if name in names]
        containers = json.loads(sp.check_output(["docker", "inspect", *managed], stderr=sp.DEVNULL, timeout=15)) if managed else []
    except (OSError, sp.SubprocessError, ValueError):
        # Neither raw Docker errors nor inspect data belong in the report.
        report["alerts"].append("docker_unavailable")
        containers = []
    else:
        split = any(
            item["Name"].lstrip("/") in PM_WEB
            and "APP_PROCESS_ROLE=web" in item["Config"].get("Env", [])
            for item in containers
        )
        for name in LIMITS:
            if name == PM_WORKER and not split:
                continue
            if name not in {item["Name"].lstrip("/") for item in containers}:
                report["alerts"].append(name + ":missing")
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    usage = shutil.disk_usage(args.output.parent)
    report["disk_used_percent"] = round(100 * usage.used / usage.total, 1)
    if usage.free < 10 * 1024**3 or report["disk_used_percent"] >= 85:
        report["alerts"].append("disk_capacity")
    backups = [path for path in args.backup_directory.glob("maibo-*.tar.gz.gpg") if path.is_file() and path.stat().st_size > 0]
    backup_age = None if not backups else (dt.datetime.now().timestamp() - max(path.stat().st_mtime for path in backups)) / 3600
    report["backup_age_hours"] = None if backup_age is None else round(backup_age, 1)
    if backup_age is None or backup_age < 0 or backup_age > 36:
        report["alerts"].append("backup_missing_or_stale")
    for item in containers:
        name = item["Name"].lstrip("/")
        config, state = item["HostConfig"], item["State"]
        if args.apply_limits:
            memory, pids, cpus = LIMITS[name]
            try:
                sp.run(["docker", "update", "--memory", str(memory) + "m", "--memory-swap", str(memory) + "m", "--pids-limit", str(pids), "--cpus", str(cpus), name], check=True, stdout=sp.DEVNULL, stderr=sp.DEVNULL, timeout=30)
                item = json.loads(sp.check_output(["docker", "inspect", name], stderr=sp.DEVNULL, timeout=15))[0]
                config, state = item["HostConfig"], item["State"]
            except (OSError, sp.SubprocessError, ValueError):
                report["alerts"].append(name + ":limits_update_failed")
        health = state["Status"]
        if state.get("Paused"):
            health = "paused"
        elif state.get("Running") and health == "running":
            health = state.get("Health", {}).get("Status", health)
        limits = resource_limits(config, name)
        rotated = log_rotation(config.get("LogConfig", {}))
        if not state.get("Running") or state.get("Paused") or health not in ("healthy", "running") or state.get("OOMKilled"):
            report["alerts"].append(name + ":unhealthy")
        if not limits:
            report["alerts"].append(name + ":resource_limits_missing_or_excessive")
        if not rotated:
            report["alerts"].append(name + ":log_rotation_pending")
        entry = {"name": name, "health": health, "resource_limits": limits, "log_rotation": rotated}
        if name == "mb-pm-v2-casdoor-1":
            persistent = casdoor_sessions_persistent(item)
            entry["casdoor_sessions_persistent"] = persistent
            if not persistent:
                report["alerts"].append(name + ":casdoor_sessions_not_persistent")
            log_storage = casdoor_logs_persistent(item)
            entry["casdoor_logs_persistent"] = log_storage
            if not log_storage:
                report["alerts"].append(name + ":casdoor_logs_not_persistent")
        report["containers"].append(entry)
    with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, prefix=args.output.name + ".", delete=False) as temp:
        json.dump(report, temp, ensure_ascii=False, indent=2)
        temp.write("\n")
    Path(temp.name).replace(args.output)
    print(json.dumps({"disk_used_percent": report["disk_used_percent"], "managed_services": len(containers), "alerts": report["alerts"]}, ensure_ascii=False))
    raise SystemExit(1 if report["alerts"] else 0)


if __name__ == "__main__":
    main()
