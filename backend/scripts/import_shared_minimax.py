#!/usr/bin/env python3
"""Server-only legacy shared MiniMax preflight; --apply requires a CAS revision."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from app.core.config import settings
from app.db.session import SessionLocal
from app.services import shared_ai_import


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-file", type=Path, required=True)
    parser.add_argument("--destination-url")
    parser.add_argument("--expected-revision", type=int)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    path = args.source_file
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_mode & 0o077
        or path.stat().st_size > 65536
    ):
        raise ValueError("Private ordinary bounded source file required")
    raw = path.read_bytes()
    before = hashlib.sha256(raw).hexdigest()
    source = json.loads(raw)
    claims = {"iss": settings.casdoor_issuer, "owner": settings.CASDOOR_ORG}
    with SessionLocal() as db:
        if args.apply:
            if args.expected_revision is None:
                raise ValueError("Expected revision required")
            result = shared_ai_import.import_profile(
                db,
                claims,
                source,
                destination_url=args.destination_url,
                expected_revision=args.expected_revision,
            )
        else:
            result = shared_ai_import.preflight(
                db, claims, source, destination_url=args.destination_url
            )
    if hashlib.sha256(path.read_bytes()).hexdigest() != before:
        raise RuntimeError("Source changed during import")
    print(json.dumps({**result, "source_preserved": True, "applied": args.apply}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            json.dumps(
                {
                    "failed": type(error).__name__,
                    "detail": "共享模型导入未完成；原配置保留，请在服务器核对输入与修订号",
                }
            )
        )
        sys.exit(1)
