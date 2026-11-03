#!/usr/bin/env python3
"""Prepare a private app.conf copy changing only Beego file-log retention.

Never edits the live input. Review the prepared copy and apply during the same
IAM storage maintenance window; all other settings and existing log options stay.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re


def update_log_config(text):
    matches = list(re.finditer(r"^([ \t]*logConfig[ \t]*=[ \t]*)([^\r\n]+)$", text, re.MULTILINE))
    if len(matches) != 1:
        raise ValueError("Expected exactly one explicit logConfig setting")
    match = matches[0]
    config = json.loads(match.group(2))
    if config.get("adapter") != "file" or config.get("filename") != "logs/casdoor.log":
        raise ValueError("Unexpected IAM log sink; review before changing retention")
    config.update(maxdays=14, maxsize=10 * 1024 * 1024, daily=True, rotate=True)
    encoded = json.dumps(config, ensure_ascii=False, separators=(",", ":"))
    return text[:match.start(2)] + encoded + text[match.end(2):]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    raw = args.source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != args.expected_sha256:
        raise SystemExit("IAM configuration changed; review before preparing a new copy")
    output = update_log_config(raw.decode()).encode()
    with args.output.open("xb") as stream:
        stream.write(output)
    print("Prepared private configuration; only log retention changed. Live file untouched.")


if __name__ == "__main__":
    main()
