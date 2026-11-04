#!/usr/bin/env python3
"""Filter assistant JSONL diagnostics from docker logs; no production credentials required."""

import argparse
import json
import sys
from uuid import UUID

FIELDS = (
    "timestamp",
    "event",
    "diagnostic_id",
    "request_id",
    "stage",
    "code",
    "status",
    "dependency_status",
    "provider",
    "model",
    "elapsed_ms",
    "duration_ms",
    "round",
    "model_rounds",
    "tool_calls",
    "tool",
    "timeout_seconds",
    "output_budget",
    "upstream_status",
    "finish_reason",
    "prompt_tokens",
    "completion_tokens",
    "reasoning_tokens",
)
EVENTS = {
    "request_started",
    "stage_started",
    "model_started",
    "model_first_content",
    "model_completed",
    "model_failed",
    "output_recovery_started",
    "tool_started",
    "tool_completed",
    "tool_failed",
    "request_completed",
    "request_failed",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", help="Diagnostic ID or client request UUID")
    parser.add_argument(
        "--failures", action="store_true", help="Only final request failures"
    )
    args = parser.parse_args()
    try:
        selected = UUID(args.id).hex if args.id else None
    except ValueError:
        parser.error("id must be a diagnostic ID or request UUID")
    found = False
    for line in sys.stdin:
        if len(line) > 32768:
            continue
        try:
            row = json.loads(line)
            if not isinstance(row, dict) or row.get("event") not in EVENTS:
                continue
            diagnostic = UUID(row["diagnostic_id"]).hex
            request = UUID(row["request_id"]).hex
        except (ValueError, TypeError, KeyError):
            continue
        if selected and selected not in (diagnostic, request):
            continue
        if args.failures and row["event"] != "request_failed":
            continue
        print(json.dumps({k: row[k] for k in FIELDS if k in row}, ensure_ascii=False))
        found = True
    return 1 if selected and not found else 0


if __name__ == "__main__":
    sys.exit(main())
