#!/usr/bin/env python3
"""Build a private split-worker overlay from the complete effective Compose config."""

import argparse
import json
import os
import re
import sys
from pathlib import Path

WORKER_ENV = {
    "APP_ENV",
    "APP_SECRET",
    "DATABASE_URL",
    "LOG_LEVEL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
}
WORKER_ENV_PREFIXES = (
    "AI_",
    "ASSISTANT_",
    "CASDOOR_",
    "INFORMATION_",
    "KNOWLEDGE_SOURCE_",
    "NOTES_WISDOM_",
    "PM_AI_",
    "PROJECT_AI_",
    "SOLUTION_KB_",
)
RUNTIME_FIELDS = (
    "depends_on",
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
    "volumes",
    "extra_hosts",
    "dns",
    "dns_search",
    "dns_opt",
    "platform",
)


def build_overlay(config):
    services = config["services"]
    source = services["app"]
    web_services = [name for name in ("app", "app-direct") if name in services]
    if "worker" in services:
        raise ValueError("An existing worker overlay must be removed from the input chain")
    image = source["image"]
    if not re.fullmatch(r"(?:[^\s@]+@)?sha256:[0-9a-f]{64}", image) or any(
        services[name]["image"] != image for name in web_services
    ):
        raise ValueError("Both web services must use the same immutable PM image")
    if (
        source.get("user") != "10001:10001"
        or source.get("read_only") is not True
        or "ALL" not in source.get("cap_drop", [])
        or "no-new-privileges:true" not in source.get("security_opt", [])
        or not all(source.get(key) for key in ("mem_limit", "cpus", "pids_limit"))
    ):
        raise ValueError("Use the complete configuration with production hardening")

    # Compose's rendered JSON already escapes literal dollars for reloading.
    environment = {
        name: value
        for name, value in source["environment"].items()
        if name.upper() in WORKER_ENV or name.upper().startswith(WORKER_ENV_PREFIXES)
    }
    if not environment.get("DATABASE_URL") or not environment.get("APP_SECRET"):
        raise ValueError("Worker requires the effective database and application credentials")
    environment.update(APP_PROCESS_ROLE="worker", AUTO_MIGRATE_SCHEMA="false", AUTO_SEED="false")
    result = {name: {"environment": {"APP_PROCESS_ROLE": "web"}} for name in web_services}
    # Retain dependency and egress networks, without borrowing aliases or static IPs.
    worker = {name: source[name] for name in RUNTIME_FIELDS if name in source}
    worker.update(
        image=image,
        environment=environment,
        networks={name: None for name in source["networks"]},
        restart="unless-stopped",
        stop_grace_period="25s",
        command=[
            "uvicorn",
            "app.worker:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8001",
            "--no-access-log",
        ],
        healthcheck={
            "test": [
                "CMD",
                "python",
                "-c",
                "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=2).close()",
            ],
            "interval": "10s",
            "timeout": "3s",
            "retries": 6,
            "start_period": "5s",
        },
    )
    result["worker"] = worker
    return {"services": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        encoded = json.dumps(build_overlay(json.load(sys.stdin)), ensure_ascii=False, indent=2)
    except (KeyError, TypeError, AttributeError, json.JSONDecodeError, UnicodeError):
        raise SystemExit("Expected valid resolved production Compose JSON on stdin") from None
    except ValueError as exc:
        raise SystemExit(str(exc)) from None

    try:
        fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise SystemExit("Cannot create worker overlay. Use a new private file path.") from None
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(encoded + "\n")
    print("Private worker overlay created")


if __name__ == "__main__":
    main()
