"""Isolated acceptance: actual PDF extraction -> signed BFF -> real Core/SQLite.

Only the IAM identity and embedding provider are deterministic fixtures. This
never loads runtime.env, connects to the user's database, or calls a paid model.
"""

import argparse
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--kb-harness", type=Path, required=True)
parser.add_argument("--node", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
repository = Path(__file__).resolve().parents[1]
os.environ["PYTHONPATH"] = (
    str(repository / "backend") + os.pathsep + os.environ.get("PYTHONPATH", "")
)
temporary = tempfile.TemporaryDirectory(prefix="folder-full-stack-")
root = Path(temporary.name)
os.environ.update(
    DATABASE_URL="sqlite:///" + str(root / "pm.sqlite"),
    AUTO_SEED="false",
    AUTO_MIGRATE_SCHEMA="false",
    ASSISTANT_REQUEST_WORKER_ENABLED="false",
    PROJECT_AI_WORKER_ENABLED="false",
    PM_AI_WORKER_ENABLED="false",
)
sys.path.insert(0, str(repository / "backend"))
sys.path.insert(0, str(repository / "extensions/knowledge-folder-core"))

import httpx
import uvicorn
from fastapi import FastAPI
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from dikw_core import api, api_retrieve
from dikw_core.config import CONFIG_FILENAME, load_config, dump_config_yaml
from dikw_core.server.app import build_app_from_disk
from dikw_core.server.auth import AuthConfig
import folder_core
from app.core.config import settings
from app.db.base import Base
from app.services import folder_imports as folders
from app.services.information import bridge
from app.services.information.store import Store
from app.api.v1 import knowledge_source_folder_imports as routes
from app.db.session import get_db

TOKEN = "fixture-only-core-token-folder-acceptance"
SECRET = "fixture-only-signed-folder-acceptance-0000000000"
core_url = "http://127.0.0.1:4336"
bff_url = "http://127.0.0.1:4337"
embedding_texts = []


class Embedder:
    async def embed(self, texts, *, model):
        embedding_texts.extend(texts)
        return [[1.0, 0.0, 0.0, 0.0] for text in texts]

    async def aclose(self):
        pass


def pdf_bytes(number):
    writer = PdfWriter()
    page = writer.add_blank_page(width=500, height=700)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/F1"): writer._add_object(font)}
            )
        }
    )
    stream = DecodedStreamObject()
    stream.set_data(
        f"BT /F1 12 Tf 30 650 Td (Independent document {number}. Experiment uniquetoken{number} yielded result {number * 17 + 9}. Scientific evidence is specific to this study.) Tj ET".encode()
    )
    page[NameObject("/Contents")] = writer._add_object(stream)
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def wait_health(url):
    for _ in range(100):
        try:
            response = httpx.get(
                url,
                timeout=1,
                trust_env=False,
                headers={"Authorization": "Bearer " + TOKEN},
            )
            if response.status_code == 200:
                return response.json()
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Isolated acceptance service did not become ready")


def finish(store, task_id):
    ident = folders.runs_for(store, task_id)[0]["id"]
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        run = store.get(folders.RUN, ident)
        if run["status"] not in folders.ACTIVE:
            return run
        folders.process_run(store, ident)
        if store.get(folders.TASK, task_id).get("paused"):
            raise AssertionError(store.get(folders.TASK, task_id).get("lastError"))
        time.sleep(0.025)
    raise AssertionError({"run": run, "items": folders.items_for(store, ident)})


base = api.init_base(root / "core")
cfg = load_config(base / CONFIG_FILENAME)
cfg.provider.embedding_dim = 4
cfg.provider.embedding_model = "local-acceptance-fixture"
cfg.provider.embedding_base_url = "http://127.0.0.1:9/v1"
cfg.provider.embedding_error_retries = 0
cfg.retrieval.rerank_enabled = False
(base / CONFIG_FILENAME).write_text(dump_config_yaml(cfg))
(base / "sources/unrelated.md").write_text(
    "# Unrelated\n\nThis pending source must not be indexed by the folder task."
)
folder_core.build_embedder = lambda config: Embedder()
api_retrieve.build_embedder = lambda config, **options: Embedder()
os.environ["DIKW_SERVER_TOKEN"] = TOKEN
core_app = build_app_from_disk(base_root=base, host="127.0.0.1")
folder_core.install(core_app, AuthConfig(host="127.0.0.1", token=TOKEN))
server = uvicorn.Server(
    uvicorn.Config(core_app, host="127.0.0.1", port=4336, log_level="warning")
)
thread = threading.Thread(target=server.run, daemon=True)
thread.start()
bff = None
engine = None
portal_server = None
portal_thread = None
try:
    wait_health(core_url + "/v1/folder-import/capabilities")
    bff_log = (root / "bff.log").open("w")
    bff = subprocess.Popen(
        [str(args.node), str(args.kb_harness)],
        cwd=args.kb_harness.parent.parent,
        env={
            **os.environ,
            "FOLDER_ACCEPTANCE_CORE_URL": core_url,
            "FOLDER_ACCEPTANCE_CORE_TOKEN": TOKEN,
            "FOLDER_ACCEPTANCE_BFF_PORT": "4337",
            "FOLDER_ACCEPTANCE_DATA_DIR": str(root / "bff"),
            "FOLDER_ACCEPTANCE_BRIDGE_SECRET": SECRET,
        },
        stdout=bff_log,
        stderr=subprocess.STDOUT,
    )
    health = wait_health(bff_url + "/health")
    source = root / "source"
    source.mkdir()
    for number in range(10):
        path = source / f"paper-{number}.pdf"
        path.write_bytes(pdf_bytes(number))
        os.utime(path, (time.time() - 10, time.time() - 10))
    settings.INFORMATION_KB_URL = bff_url
    settings.INFORMATION_KB_SECRET = SECRET
    settings.INFORMATION_DATA_DIR = str(root / "originals")
    settings.KNOWLEDGE_FOLDER_IMPORT_ROOTS = json.dumps(
        [{"id": "mounted", "name": "Isolated test mount", "path": str(source)}]
    )
    folders.authority = (
        lambda db, subject: None
    )  # fixture identity only; BFF still verifies IAM role
    engine = create_engine("sqlite:///" + str(root / "pm.sqlite"))
    Base.metadata.create_all(engine)
    actor = {"subject": health["subject"], "tenant": "isolated-folder-acceptance"}
    config = {
        "name": "10 PDF full stack acceptance",
        "kind": "server",
        "serverRootId": "mounted",
        "path": "",
        "folderId": health["folderId"],
        "includeSubfolders": True,
        "preserveHierarchy": False,
        "maxFileMb": 100,
        "maxFilesPerScan": 1000,
        "schedule": {
            "frequency": "daily",
            "time": "08:00",
            "timezone": "Asia/Shanghai",
            "weekday": 0,
        },
    }
    with Session(engine) as db:
        store = Store(db, actor["tenant"])
        task = folders.create_task(store, actor, config)
        first = finish(store, task["id"])
        assert (
            first["status"] == "completed"
            and first["completed"] == 10
            and first["failed"] == 0
        ), {"run": first, "items": folders.items_for(store, first["id"])}
        items = folders.items_for(store, first["id"])
        assert len({i["sha256"] for i in items}) == 10
        assert all(i["originalSaved"] and i["indexStatus"] == "ready" for i in items)
        before = len(embedding_texts)
        folders.queue_scan(store, task["id"], actor["subject"])
        second = finish(store, task["id"])
        assert (
            second["unchanged"] == 10
            and second["new"] == 0
            and len(embedding_texts) == before
        )
        # A second task/folder binding must share already parsed originals and vectors.
        reuse_task = folders.create_task(
            store, actor, {**config, "name": "shared original reuse"}
        )
        reused = finish(store, reuse_task["id"])
        assert reused["completed"] == 10 and len(embedding_texts) == before, {
            "run": reused,
            "items": folders.items_for(store, reused["id"]),
        }
        pages = httpx.get(
            core_url + "/v1/base/pages",
            headers={"Authorization": "Bearer " + TOKEN},
            trust_env=False,
        ).json()
        assert len(pages) == 10 and all(
            p["path"] != "sources/unrelated.md" for p in pages
        ), pages
        catalogue = bridge.call("librarySummary", actor["subject"])
        assert catalogue.get("canWrite") is True
        # Exercise the actual connector HTTP pairing, multipart upload, lease,
        # manifest and finish endpoints. One new original and nine reused ones.
        local_source = root / "local-source"
        local_source.mkdir()
        for number in range(10):
            (local_source / f"local-{number}.pdf").write_bytes(
                pdf_bytes(number if number else 100)
            )
        local_task = folders.create_task(
            store,
            actor,
            {
                **config,
                "kind": "local",
                "serverRootId": None,
                "name": "local connector acceptance",
            },
        )
        pairing = folders.pair_code(store, local_task["id"], actor)
        portal = FastAPI()
        portal.include_router(routes.router, prefix="/api/v1")

        def database():
            with Session(engine) as session:
                yield session

        portal.dependency_overrides[get_db] = database
        portal.dependency_overrides[routes.principal] = lambda: {
            **actor,
            "manage": True,
        }
        portal.dependency_overrides[routes.manager] = lambda: {**actor, "manage": True}
        portal_server = uvicorn.Server(
            uvicorn.Config(portal, host="127.0.0.1", port=4338, log_level="warning")
        )
        portal_thread = threading.Thread(target=portal_server.run, daemon=True)
        portal_thread.start()
        wait_health(
            "http://127.0.0.1:4338/api/v1/knowledge-sources/v3/folder-imports/bootstrap"
        )
        connector_spec = importlib.util.spec_from_file_location(
            "acceptance_connector", repository / "scripts/knowledge-folder-connector.py"
        )
        connector = importlib.util.module_from_spec(connector_spec)
        connector_spec.loader.exec_module(connector)
        result = connector.main(
            [
                "--server",
                "http://127.0.0.1:4338",
                "--code",
                pairing["code"],
                "--folder",
                str(local_source),
                "--config",
                str(root / "connector.json"),
                "--once",
            ]
        )
        assert result == 0
        local = finish(store, local_task["id"])
        assert local["completed"] == 10 and local["failed"] == 0, {
            "run": local,
            "items": folders.items_for(store, local["id"]),
        }
        assert len(embedding_texts) - before == 1
        # Real retrieval route, using a deterministic local embedding fixture.
        answer = httpx.post(
            core_url + "/v1/retrieve",
            json={"q": "uniquetoken100", "limit": 10},
            headers={"Authorization": "Bearer " + TOKEN},
            timeout=30,
            trust_env=False,
        )
        events = [json.loads(line) for line in answer.text.splitlines() if line.strip()]
        final = next(
            event for event in reversed(events) if event.get("type") == "final"
        )
        assert final["status"] == "succeeded", final
        assert any(
            "uniquetoken100" in item.get("text", "")
            for item in final["result"]["chunks"]
        ), final
        proof = {
            "initialFiles": 10,
            "differentHashes": 10,
            "originalsSaved": 10,
            "parsedAndIndexed": 10,
            "coreActiveDocuments": len(pages),
            "secondScanUnchanged": second["unchanged"],
            "sameContentSecondTaskCompleted": reused["completed"],
            "duplicateEmbeddingCalls": 0,
            "localConnectorCompleted": local["completed"],
            "localConnectorNewOriginalsTransferred": 1,
            "realRetrievalHitNewLocalDocument": True,
            "unrelatedPendingSourceIndexed": False,
            "iam": "isolated fixture manager",
            "embeddings": "deterministic local fixture through real Core pipeline",
            "productionTouched": False,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
        print(json.dumps(proof, ensure_ascii=False))
finally:
    if portal_server:
        portal_server.should_exit = True
        portal_thread.join(timeout=5)
    if bff:
        bff.terminate()
        try:
            bff.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bff.kill()
    server.should_exit = True
    thread.join(timeout=5)
    if engine:
        engine.dispose()
    temporary.cleanup()
