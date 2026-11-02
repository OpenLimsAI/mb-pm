#!/usr/bin/env python3
"""Server-local health/capacity evidence; no external notification credentials required."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess as sp

# MiB / PIDs / CPUs. Only named production services; never unknown candidate containers.
LIMITS = {
    "mb-pm-v2-app-1": (1536, 128, 2), "mb-pm-v2-app-direct-1": (1536, 128, 2),
    "mb-pm-v2-pms-db-1": (2048, 256, 2), "mb-pm-v2-iam-db-1": (1024, 256, 2),
    "mb-pm-v2-casdoor-1": (2048, 256, 2), "mb-pm-v2-tunnel-1": (256, 128, 1),
    "mb-pm-v2-direct-proxy-1": (256, 128, 1), "iam-proxy": (256, 128, 1),
    "dikw-mbweb": (1536, 256, 2), "dikw-web": (1536, 256, 2),
    "dikw-core": (4096, 512, 4), "dikw-postgres": (3072, 256, 2), "dikw-caddy": (256, 128, 1),
    "cmab-mdm-maibo-web-1": (512, 128, 1), "cmab-mdm-maibo-backend-1": (2048, 256, 2),
    "cmab-mdm-maibo-postgres-1": (1536, 256, 2), "cmab-mdm-maibo-redis-1": (512, 128, 1),
}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--backup-directory", type=Path, required=True)
    p.add_argument("--apply-limits", action="store_true")
    args = p.parse_args()
    os.umask(0o077)
    names = sp.check_output(["docker", "ps", "--format", "{{.Names}}"]).decode().splitlines()
    managed = [name for name in names if name in LIMITS]
    containers = json.loads(sp.check_output(["docker", "inspect", *managed])) if managed else []
    report = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "alerts": [], "containers": []}
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    usage = shutil.disk_usage(args.output.parent)
    report["disk_used_percent"] = round(100 * usage.used / usage.total, 1)
    if usage.free < 10 * 1024**3 or report["disk_used_percent"] >= 85:
        report["alerts"].append("disk_capacity")
    backups = sorted(args.backup_directory.glob("maibo-*.tar.gz.gpg"))
    backup_age = None if not backups else (dt.datetime.now().timestamp() - backups[-1].stat().st_mtime) / 3600
    report["backup_age_hours"] = None if backup_age is None else round(backup_age, 1)
    if backup_age is None or backup_age > 36:
        report["alerts"].append("backup_missing_or_stale")
    for item in containers:
        name = item["Name"].lstrip("/")
        config, state = item["HostConfig"], item["State"]
        if args.apply_limits:
            memory, pids, cpus = LIMITS[name]
            sp.run(["docker", "update", "--memory", str(memory) + "m", "--memory-swap", str(memory) + "m", "--pids-limit", str(pids), "--cpus", str(cpus), name], check=True, stdout=sp.DEVNULL)
            item = json.loads(sp.check_output(["docker", "inspect", name]))[0]
            config, state = item["HostConfig"], item["State"]
        health = state.get("Health", {}).get("Status", state["Status"])
        limits = bool(config.get("Memory") and (config.get("PidsLimit") or 0) > 0)
        log_options = config.get("LogConfig", {}).get("Config", {})
        rotated = bool(log_options.get("max-size") and log_options.get("max-file"))
        if health not in ("healthy", "running") or state.get("OOMKilled"):
            report["alerts"].append(name + ":unhealthy")
        if not limits:
            report["alerts"].append(name + ":unbounded")
        if not rotated:
            report["alerts"].append(name + ":log_rotation_pending")
        report["containers"].append({"name": name, "health": health, "resource_limits": limits, "log_rotation": rotated})
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = args.output.with_suffix(".tmp")
    temp.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    temp.replace(args.output)
    print(json.dumps({"disk_used_percent": report["disk_used_percent"], "managed_services": len(managed), "alerts": report["alerts"]}, ensure_ascii=False))
    raise SystemExit(1 if report["alerts"] else 0)


if __name__ == "__main__":
    main()
