"""Launch the pinned Core with the optional folder-import extension."""

import argparse
from pathlib import Path

import uvicorn
from dikw_core.server.app import build_app_from_disk
from dikw_core.server.auth import ensure_auth_invariant, load_auth_config
from folder_core import install

parser = argparse.ArgumentParser()
parser.add_argument("--base", type=Path, required=True)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8765)
args = parser.parse_args()
auth = load_auth_config(host=args.host)
ensure_auth_invariant(auth)
app = build_app_from_disk(base_root=args.base.resolve(), host=args.host)
install(app, auth)
uvicorn.run(app, host=args.host, port=args.port)
