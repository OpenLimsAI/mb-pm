"""Phase 2 & Phase 3 regression tests: modular boundaries, TTL retention, and exec-free Core extension."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from app.db.session import SessionLocal
from app.models.information import InformationEntry
from app.services import folder_imports as folders
from app.services.information.store import Store
from app.services.knowledge_source_retention import (
    maybe_prune_expired_entries,
    prune_expired_entries,
    reset_sweep_timer,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_folder_core_with_stubs(monkeypatch):
    fake_dikw = types.ModuleType("dikw_core")
    fake_ingest = types.ModuleType("dikw_core.api_ingest")

    def default_iter_source_files(sources_cfg, *, root):
        return iter(
            [
                (root / "sources" / "a.md", "sources/a.md"),
                (root / "sources" / "b.md", "sources/b.md"),
            ]
        )

    async def default_with_storage(path):
        cfg = types.SimpleNamespace(sources="sources")
        return cfg, Path(path), MagicMock(name="raw_storage")

    async def upstream_ingest(path, *, embedder=None, reporter=None):
        cfg, root, storage = await _with_storage(path)  # noqa: F821
        visited = [logical for _, logical in iter_source_files(cfg.sources, root=root)]  # noqa: F821
        return {"visited": visited, "storage_type": type(storage).__name__, "embedder": embedder}

    fake_ingest.iter_source_files = default_iter_source_files
    fake_ingest._with_storage = default_with_storage
    upstream_ingest.__globals__["iter_source_files"] = default_iter_source_files
    upstream_ingest.__globals__["_with_storage"] = default_with_storage
    fake_ingest.ingest = types.FunctionType(
        upstream_ingest.__code__,
        fake_ingest.__dict__,
        name="ingest",
        argdefs=upstream_ingest.__defaults__,
        closure=upstream_ingest.__closure__,
    )
    fake_ingest.ingest.__kwdefaults__ = dict(upstream_ingest.__kwdefaults__ or {})
    fake_ingest.parse_any = MagicMock()
    fake_dikw.api_ingest = fake_ingest

    fake_api_core = types.ModuleType("dikw_core.api_core")
    fake_api_core._with_storage = default_with_storage
    fake_api_core._resolve_active_text_version_for_inline_embed = MagicMock()

    fake_cfg = types.ModuleType("dikw_core.config")
    fake_cfg.CONFIG_FILENAME = "dikw.yaml"
    fake_cfg.load_config = MagicMock()

    fake_path_norm = types.ModuleType("dikw_core.domains.data.path_norm")
    fake_path_norm.doc_id_for = lambda layer, path: f"doc:{path}"

    fake_sources = types.ModuleType("dikw_core.domains.data.sources")
    fake_sources.iter_source_files = default_iter_source_files

    fake_providers = types.ModuleType("dikw_core.providers")
    fake_providers.build_embedder = MagicMock()

    fake_schemas = types.ModuleType("dikw_core.schemas")
    fake_schemas.Layer = types.SimpleNamespace(SOURCE="source")

    fake_md_inspect = types.ModuleType("dikw_core.md_inspect")
    fake_md_inspect.sha256_file = lambda p: "0" * 64

    fake_auth = types.ModuleType("dikw_core.server.auth")
    fake_auth.make_dependency = lambda auth: (lambda: None)

    fake_runtime = types.ModuleType("dikw_core.server.runtime")
    fake_runtime.get_runtime = MagicMock()

    fake_routes_tasks = types.ModuleType("dikw_core.server.routes_tasks")
    fake_routes_tasks._handle = MagicMock()
    fake_routes_tasks.IngestSubmit = object
    fake_routes_tasks.TaskHandle = object

    fake_tasks_mgr = types.ModuleType("dikw_core.server.tasks.manager")
    fake_tasks_mgr._params_digest = lambda op, params: "digest"

    stubs = {
        "dikw_core": fake_dikw,
        "dikw_core.api_ingest": fake_ingest,
        "dikw_core.api_core": fake_api_core,
        "dikw_core.config": fake_cfg,
        "dikw_core.domains.data": types.ModuleType("dikw_core.domains.data"),
        "dikw_core.domains.data.path_norm": fake_path_norm,
        "dikw_core.domains.data.sources": fake_sources,
        "dikw_core.providers": fake_providers,
        "dikw_core.schemas": fake_schemas,
        "dikw_core.md_inspect": fake_md_inspect,
        "dikw_core.server": types.ModuleType("dikw_core.server"),
        "dikw_core.server.auth": fake_auth,
        "dikw_core.server.runtime": fake_runtime,
        "dikw_core.server.routes_tasks": fake_routes_tasks,
        "dikw_core.server.tasks": types.ModuleType("dikw_core.server.tasks"),
        "dikw_core.server.tasks.manager": fake_tasks_mgr,
    }
    for mod_name, mod in stubs.items():
        monkeypatch.setitem(sys.modules, mod_name, mod)
    monkeypatch.setattr(
        "importlib.metadata.version",
        lambda pkg: "0.6.12" if pkg == "dikw-core" else "1.0.0",
    )

    spec = importlib.util.spec_from_file_location(
        "folder_core_phase3", REPO_ROOT / "extensions/knowledge-folder-core/folder_core.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, fake_ingest


def test_phase2_folder_imports_decomposed_and_zero_ks_service_to_api_imports():
    # Public facade stays lightweight (< 200 lines) while delegating to focused submodules.
    facade_lines = (REPO_ROOT / "backend/app/services/folder_imports.py").read_text().splitlines()
    assert len(facade_lines) < 200
    assert callable(folders.create_task)
    assert callable(folders.process_run)
    assert callable(folders.pair_connector)

    # Zero Knowledge Sources services import from `app.api.*`.
    services_dir = REPO_ROOT / "backend/app/services"
    ks_service_files = [
        *services_dir.glob("knowledge_source*.py"),
        *services_dir.glob("information/*.py"),
        services_dir / "folder_imports.py",
    ]
    for path in ks_service_files:
        content = path.read_text(encoding="utf-8")
        assert (
            "from app.api" not in content and "import app.api" not in content
        ), f"{path.name} must not depend on app.api layer"


def test_phase3_ttl_retention_prunes_expired_ephemeral_and_aged_ledger_rows(client):
    _ = client
    with SessionLocal() as db:
        _run_ttl_retention_assertions(db)


def _run_ttl_retention_assertions(db):
    now = 1_800_000_000.0
    store = Store(db, "tenant-ttl")

    # Expired ephemeral entries (>24h past expiry) -> should be pruned
    db.add(
        InformationEntry(
            id="pair-expired",
            tenant="tenant-ttl",
            kind="fi_pair",
            data={"id": "pair-expired", "expires": now - 90000},
            updated_at=now - 90000,
        )
    )
    db.add(
        InformationEntry(
            id="undo-expired",
            tenant="tenant-ttl",
            kind="ks_undo",
            data={"id": "undo-expired", "expiresAt": now - 90000},
            updated_at=now - 90000,
        )
    )
    # Active/fresh ephemeral entry -> must be retained
    db.add(
        InformationEntry(
            id="pair-active",
            tenant="tenant-ttl",
            kind="fi_pair",
            data={"id": "pair-active", "expires": now + 600},
            updated_at=now,
        )
    )
    # Aged (>90d) audit & meter rows -> should be pruned
    db.add(
        InformationEntry(
            id="audit-old",
            tenant="tenant-ttl",
            kind="audit",
            data={"id": "audit-old"},
            updated_at=now - 95 * 86400,
        )
    )
    db.add(
        InformationEntry(
            id="meter-old",
            tenant="tenant-ttl",
            kind="fi_meter",
            data={"id": "meter-old"},
            updated_at=now - 95 * 86400,
        )
    )
    # Durable business document (<90d or >90d) -> NEVER pruned
    store.put("document", {"id": "doc-durable", "sourceId": "s1", "title": "Keep Me"})
    row_doc = db.get(InformationEntry, "doc-durable")
    row_doc.updated_at = now - 365 * 86400
    db.commit()

    pruned = prune_expired_entries(db, now=now)
    assert pruned == {"fi_pair": 1, "ks_undo": 1, "audit": 1, "fi_meter": 1}
    assert db.get(InformationEntry, "pair-expired") is None
    assert db.get(InformationEntry, "undo-expired") is None
    assert db.get(InformationEntry, "audit-old") is None
    assert db.get(InformationEntry, "meter-old") is None
    assert db.get(InformationEntry, "pair-active") is not None
    assert db.get(InformationEntry, "doc-durable") is not None

    # Rate-limiter skips repeated sweep within the same hour
    reset_sweep_timer()
    first = maybe_prune_expired_entries(db, now=now)
    assert first == {}
    db.add(
        InformationEntry(
            id="pair-expired-2",
            tenant="tenant-ttl",
            kind="fi_pair",
            data={"id": "pair-expired-2", "expires": now - 90000},
            updated_at=now - 90000,
        )
    )
    db.commit()
    assert maybe_prune_expired_entries(db, now=now + 60) == {}
    assert db.get(InformationEntry, "pair-expired-2") is not None
    assert maybe_prune_expired_entries(db, now=now + 3601) == {"fi_pair": 1}
    assert db.get(InformationEntry, "pair-expired-2") is None


def test_phase3_folder_core_exec_free_function_cloning_and_version_contract(tmp_path, monkeypatch):
    import ast

    core_source = (REPO_ROOT / "extensions/knowledge-folder-core/folder_core.py").read_text(
        encoding="utf-8"
    )
    assert not any(
        isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "exec"
        for node in ast.walk(ast.parse(core_source))
    )

    folder_core, fake_ingest = _load_folder_core_with_stubs(monkeypatch)
    # Accepts compatible minor/patch upgrades (e.g. 0.6.12, 0.7.1) and rejects 0.5.9 / 0.8.0
    assert (
        folder_core.verify_ingest_contract(fake_ingest, version_str="0.6.12") is fake_ingest.ingest
    )
    assert (
        folder_core.verify_ingest_contract(fake_ingest, version_str="0.7.2") is fake_ingest.ingest
    )
    with pytest.raises(RuntimeError, match=">=0.6.10,<0.8.0"):
        folder_core.verify_ingest_contract(fake_ingest, version_str="0.8.0")
    with pytest.raises(RuntimeError, match=">=0.6.10,<0.8.0"):
        folder_core.verify_ingest_contract(fake_ingest, version_str="0.6.9")

    # Scoped engine filters strictly to selected paths and wraps storage in ScopedStorage
    # without mutating upstream `fake_ingest` globals!
    (tmp_path / "sources").mkdir()
    (tmp_path / "sources" / "a.md").write_text("# A", encoding="utf-8")
    (tmp_path / "sources" / "b.md").write_text("# B", encoding="utf-8")

    scoped_fn = folder_core.scoped_engine(
        {"sources/b.md"}, {"sources/b.md"}, ingest_module=fake_ingest
    )
    res = asyncio.run(scoped_fn(tmp_path, embedder="local-embed"))
    assert res == {
        "visited": ["sources/b.md"],
        "storage_type": "ScopedStorage",
        "embedder": "local-embed",
    }
    # Upstream ingest remains untouched and still sees both files
    upstream_res = asyncio.run(fake_ingest.ingest(tmp_path))
    assert upstream_res["visited"] == ["sources/a.md", "sources/b.md"]

    # Decorated upstream ingest (e.g. @traced_op using @functools.wraps) unwraps cleanly
    import functools

    raw_inner = fake_ingest.ingest

    @functools.wraps(raw_inner)
    async def traced_wrapper(*args, **kwargs):
        return await raw_inner(*args, **kwargs)

    fake_ingest.ingest = traced_wrapper
    assert folder_core.verify_ingest_contract(fake_ingest, version_str="0.6.10") is raw_inner
    scoped_wrapped = folder_core.scoped_engine(
        {"sources/a.md"}, {"sources/a.md"}, ingest_module=fake_ingest
    )
    wrapped_res = asyncio.run(scoped_wrapped(tmp_path, embedder="wrapped-embed"))
    assert wrapped_res == {
        "visited": ["sources/a.md"],
        "storage_type": "ScopedStorage",
        "embedder": "wrapped-embed",
    }
