#!/usr/bin/env python3
"""Fail closed except exact, expiring, reviewed non-reachable advisories."""
import datetime as dt
import json
from pathlib import Path
import sys

exceptions = {
    ("ecdsa", "0.19.2", "CVE-2024-23342"),  # No ECDSA signing/key generation; RSA only.
    ("python-jose", "3.5.0", "CVE-2026-85394"),  # JWT decoder enforces algorithms=['RS256'].
}
expires = dt.date(2026, 12, 2)
report = json.loads(Path(sys.argv[1]).read_text())
if not isinstance(report.get("dependencies"), list) or not report["dependencies"]:
    raise SystemExit("Audit produced no dependency results")
failures = []
accepted = set()
for dependency in report["dependencies"]:
    if dependency.get("skip_reason"):
        failures.append((dependency["name"], "not audited"))
    for vulnerability in dependency.get("vulns", []):
        ids = {vulnerability["id"], *vulnerability.get("aliases", [])}
        allowed = any((dependency["name"], dependency["version"], identifier) in exceptions for identifier in ids)
        if allowed and dt.datetime.now(dt.timezone.utc).date() <= expires:
            accepted.add((dependency["name"], vulnerability["id"]))
        else:
            failures.append((dependency["name"], vulnerability["id"]))
print("Reviewed exceptions:", sorted(accepted), "expire:", expires)
if failures:
    print("Blocking findings:", failures)
    raise SystemExit(1)
print("Dependency audit passed with the listed scoped exceptions")
