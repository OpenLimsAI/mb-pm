"""Core >=0.6.10,<0.8 extension: scoped indexing and durable version promotion.

Clones the upstream `dikw_core.api_ingest.ingest` coroutine via `types.FunctionType`
with a private globals dictionary (zero `exec()`, zero source-text splicing).
The installed package and ordinary ingest globals are never modified. Only source
enumeration (`iter_source_files`) and `_with_storage` are substituted; parsing,
chunking, and embedding remain Core's own implementation.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import importlib.metadata
import inspect
import re
import types
from pathlib import Path, PurePosixPath
from urllib.parse import unquote_to_bytes

from dikw_core import api_ingest
from dikw_core.api_core import (
    _resolve_active_text_version_for_inline_embed,
    _with_storage,
)
from dikw_core.config import CONFIG_FILENAME, load_config
from dikw_core.domains.data.path_norm import doc_id_for
from dikw_core.domains.data.sources import iter_source_files
from dikw_core.md_inspect import sha256_file
from dikw_core.providers import build_embedder
from dikw_core.schemas import Layer
from dikw_core.server.auth import make_dependency
from dikw_core.server.routes_tasks import IngestSubmit, TaskHandle, _handle
from dikw_core.server.runtime import get_runtime
from dikw_core.server.tasks.manager import _params_digest
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

MIN_CORE_VERSION = (0, 6, 10)
MAX_CORE_VERSION_EXCLUSIVE = (0, 8, 0)
TABLES = (
    "CREATE TABLE IF NOT EXISTS mberp_folder_families (family_key TEXT PRIMARY KEY, path TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS mberp_folder_versions (family_key TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(family_key,path))",
)


class ManualOriginal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    sourceHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    path: str = Field(pattern=r"^sources/upload-[0-9a-f]{21,64}\.md$")


def discard_manual_files(root, upload):
    """Trash one verified upload package, preserving PDFs referenced elsewhere."""
    source_dir = root / "sources"
    pdf_name = f"{upload.sha256}.pdf"
    markdown = root / upload.path
    pdf = source_dir / pdf_name
    trash = root / "trash" / "manual-uploads" / upload.sourceHash
    trashed_source = trash / markdown.name
    trashed_pdf = trash / pdf_name
    for path in (markdown, pdf, trashed_source, trashed_pdf):
        parts = path.relative_to(root).parts
        if any(
            root.joinpath(*parts[:i]).is_symlink() for i in range(1, len(parts) + 1)
        ):
            raise HTTPException(409, "原件存储路径异常，请联系管理员")
    proof = markdown if markdown.is_file() else trashed_source
    if not proof.is_file() or sha256_file(proof) != upload.sourceHash:
        raise HTTPException(409, "原件与上传记录不一致，请刷新后重试")
    if not proof.read_bytes().startswith(
        f'---\nsource_kind: "manual-upload"\noriginal_sha256: "{upload.sha256}"\n'.encode()
    ):
        raise HTTPException(409, "无法确认文件属于这次手动上传")
    original = pdf if pdf.is_file() else trashed_pdf
    if not original.is_file() or sha256_file(original) != upload.sha256:
        raise HTTPException(409, "无法核对 PDF 原件，请联系管理员")
    trash.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Moving Markdown first also prevents ordinary ingest from discovering it
    # after a partial failure. The same request can resume using the trash copy.
    if markdown.is_file():
        markdown.replace(trashed_source)
    if pdf.is_file():
        resolved_root = root.resolve()
        for name in ("sources", "knowledge", "wisdom"):
            for page in (root / name).rglob("*.md"):
                if (
                    page.is_symlink()
                    or not page.resolve().is_relative_to(resolved_root)
                    or not page.is_file()
                ):
                    continue
                if pdf_name.encode() in unquote_to_bytes(page.read_bytes()):
                    return {"discarded": True, "sharedOriginalRetained": True}
        pdf.replace(trashed_pdf)
    return {"discarded": True, "sharedOriginalRetained": False}


def _parse_version_tuple(raw: str) -> tuple[int, int, int]:
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", raw.strip())
    if not match:
        raise RuntimeError(f"Unsupported dikw-core version format: {raw!r}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def verify_ingest_contract(ingest_module=api_ingest, version_str: str | None = None):
    raw_version = version_str or importlib.metadata.version("dikw-core")
    parsed_version = _parse_version_tuple(raw_version)
    if not (MIN_CORE_VERSION <= parsed_version < MAX_CORE_VERSION_EXCLUSIVE):
        raise RuntimeError(
            f"Folder extension requires dikw-core >=0.6.10,<0.8.0 (got {raw_version})"
        )
    raw_ingest_fn = getattr(ingest_module, "ingest", None)
    ingest_fn = inspect.unwrap(raw_ingest_fn) if raw_ingest_fn is not None else None
    if not inspect.iscoroutinefunction(ingest_fn):
        raise RuntimeError("Upstream dikw_core.api_ingest.ingest is not an async function")
    required_globals = {"iter_source_files", "_with_storage"}
    referenced = set(ingest_fn.__code__.co_names)
    if not required_globals <= referenced:
        missing = sorted(required_globals - referenced)
        raise RuntimeError(f"Core ingest contract changed; missing globals: {missing}")
    for symbol in required_globals:
        if not callable(getattr(ingest_module, symbol, None)):
            raise RuntimeError(f"Core ingest global {symbol} is not callable")
    return ingest_fn


def checked_path(root, value):
    if (
        not isinstance(value, str)
        or len(value) > 2000
        or "\\" in value
        or "\0" in value
    ):
        raise ValueError("Invalid source path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(x in {"", ".", ".."} for x in value.split("/")):
        raise ValueError("Invalid source path")
    if relative.parts[0] != "sources" or relative.suffix.lower() != ".md":
        raise ValueError("Only imported source Markdown can be indexed")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Source symlinks are not permitted")
    if not current.resolve(strict=True).is_relative_to(root.resolve()):
        raise ValueError("Source escapes base")
    if not current.is_file():
        raise ValueError("Source is unavailable")
    return value


def is_sqlite(storage):
    return type(storage).__module__ == "dikw_core.storage.sqlite"


def is_postgres(storage):
    return type(storage).__module__ == "dikw_core.storage.postgres"


async def registry(storage):
    if is_sqlite(storage):

        def read():
            connection = storage._require_conn()
            with connection:
                for sql in TABLES:
                    connection.execute(sql)
                return dict(
                    connection.execute(
                        "SELECT family_key,path FROM mberp_folder_families"
                    ).fetchall()
                )

        return await storage._locked(read)
    if is_postgres(storage):
        async with storage._acquire() as connection:
            for sql in TABLES:
                await connection.execute(sql)
            result = await connection.execute(
                "SELECT family_key,path FROM mberp_folder_families"
            )
            return {family: path for family, path in await result.fetchall()}
    raise RuntimeError(
        "Folder extension supports only reviewed SQLite/PostgreSQL adapters"
    )


async def stage(storage, family, path):
    await registry(storage)
    if is_sqlite(storage):

        def write():
            with storage._require_conn() as connection:
                connection.execute(
                    "INSERT OR IGNORE INTO mberp_folder_versions VALUES (?,?)",
                    (family, path),
                )

        await storage._locked(write)
    else:
        async with storage._acquire() as connection:
            await connection.execute(
                "INSERT INTO mberp_folder_versions VALUES (%s,%s) ON CONFLICT DO NOTHING",
                (family, path),
            )


async def inactive_versions(storage):
    await registry(storage)
    sql = "SELECT DISTINCT v.path FROM mberp_folder_versions v WHERE NOT EXISTS(SELECT 1 FROM mberp_folder_families f WHERE f.path=v.path)"
    if is_sqlite(storage):
        return await storage._locked(
            lambda: {row[0] for row in storage._require_conn().execute(sql).fetchall()}
        )
    async with storage._acquire() as connection:
        result = await connection.execute(sql)
        return {path for (path,) in await result.fetchall()}


async def promote(storage, family, path, previous):
    """The active pointer and both visibility flags commit in one DB transaction."""
    if is_sqlite(storage):

        def write():
            connection = storage._require_conn()
            with connection:
                row = connection.execute(
                    "SELECT path FROM mberp_folder_families WHERE family_key=?",
                    (family,),
                ).fetchone()
                current = row[0] if row else None
                if current not in {previous, path}:
                    raise ValueError("Source version changed; refresh before promoting")
                doc_id = doc_id_for(Layer.SOURCE, path)
                if not connection.execute(
                    "SELECT 1 FROM documents WHERE doc_id=?", (doc_id,)
                ).fetchone():
                    raise ValueError("Indexed source is missing")
                connection.execute(
                    "INSERT INTO mberp_folder_families VALUES (?,?) ON CONFLICT(family_key) DO UPDATE SET path=excluded.path",
                    (family, path),
                )
                connection.execute(
                    "UPDATE documents SET active=1 WHERE doc_id=?", (doc_id,)
                )
                if (
                    current
                    and current != path
                    and not connection.execute(
                        "SELECT 1 FROM mberp_folder_families WHERE path=?", (current,)
                    ).fetchone()
                ):
                    connection.execute(
                        "UPDATE documents SET active=0 WHERE doc_id=?",
                        (doc_id_for(Layer.SOURCE, current),),
                    )

        await storage._locked(write)
    else:
        async with storage._acquire() as connection, connection.transaction():
            # Runtime lock serializes this base; advisory transaction lock also
            # protects the family when more than one Core replica is present.
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (family,)
            )
            result = await connection.execute(
                "SELECT path FROM mberp_folder_families WHERE family_key=%s FOR UPDATE",
                (family,),
            )
            row = await result.fetchone()
            current = row[0] if row else None
            if current not in {previous, path}:
                raise ValueError("Source version changed; refresh before promoting")
            result = await connection.execute(
                "SELECT 1 FROM documents WHERE doc_id=%s",
                (doc_id_for(Layer.SOURCE, path),),
            )
            if not await result.fetchone():
                raise ValueError("Indexed source is missing")
            await connection.execute(
                "INSERT INTO mberp_folder_families VALUES (%s,%s) ON CONFLICT(family_key) DO UPDATE SET path=excluded.path",
                (family, path),
            )
            await connection.execute(
                "UPDATE documents SET active=TRUE WHERE doc_id=%s",
                (doc_id_for(Layer.SOURCE, path),),
            )
            if current and current != path:
                await connection.execute(
                    "UPDATE documents SET active=FALSE WHERE doc_id=%s AND NOT EXISTS(SELECT 1 FROM mberp_folder_families WHERE path=%s)",
                    (doc_id_for(Layer.SOURCE, current), current),
                )


class ScopedStorage:
    def __init__(self, storage, paths, active_paths, *, full=False, excluded=()):
        self.storage = storage
        self.paths = set(paths)
        self.ids = {doc_id_for(Layer.SOURCE, p) for p in paths}
        self.active_paths = set(active_paths)
        self.full = full
        self.excluded_ids = {doc_id_for(Layer.SOURCE, p) for p in excluded}

    def __getattr__(self, name):
        return getattr(self.storage, name)

    async def upsert_document(self, document):
        if document.doc_id not in self.ids:
            raise ValueError("Scoped ingest attempted to write an unrelated source")
        # New versions remain invisible to retrieval until all embedding work is
        # confirmed. A previously ready identical version remains available.
        await self.storage.upsert_document(
            document.model_copy(update={"active": document.path in self.active_paths})
        )

    async def list_chunks_missing_embedding(self, *, version_id):
        return [
            c
            for c in await self.storage.list_chunks_missing_embedding(
                version_id=version_id
            )
            if (
                c.doc_id not in self.excluded_ids if self.full else c.doc_id in self.ids
            )
        ]

    async def list_assets_missing_embedding(self, *, version_id):
        # The new assets of selected sources still use Core's normal pipeline;
        # the optional corpus-wide backfill is outside this operation's scope.
        return (
            await self.storage.list_assets_missing_embedding(version_id=version_id)
            if self.full
            else []
        )

    async def upsert_embed_version(self, version):
        if self.full:
            return await self.storage.upsert_embed_version(version)
        active = await self.storage.get_active_embed_version(modality=version.modality)
        if active:
            fields = (
                "provider",
                "model",
                "revision",
                "dim",
                "normalize",
                "distance",
                "modality",
            )
            if any(getattr(active, f) != getattr(version, f) for f in fields):
                raise ValueError(
                    "Embedding configuration changed; complete an explicit model migration before automatic imports"
                )
            return active.version_id
        return await self.storage.upsert_embed_version(version)


def scoped_engine(paths, active_paths, *, full=False, excluded=(), ingest_module=api_ingest):
    ingest_fn = verify_ingest_contract(ingest_module)

    def selected(sources_cfg, *, root):
        for absolute, logical in iter_source_files(sources_cfg, root=root):
            if logical in paths:
                if not full:
                    checked_path(root, logical)
                yield absolute, logical

    async def storage_factory(path):
        cfg, root, storage = await _with_storage(path)
        return (
            cfg,
            root,
            ScopedStorage(storage, paths, active_paths, full=full, excluded=excluded),
        )

    private_globals = {
        **ingest_module.__dict__,
        "iter_source_files": selected,
        "_with_storage": storage_factory,
    }
    cloned = types.FunctionType(
        ingest_fn.__code__,
        private_globals,
        name=ingest_fn.__name__,
        argdefs=ingest_fn.__defaults__,
        closure=ingest_fn.__closure__,
    )
    cloned.__kwdefaults__ = copy_kwdefaults = (
        dict(ingest_fn.__kwdefaults__) if ingest_fn.__kwdefaults__ else None
    )
    _ = copy_kwdefaults
    return cloned


async def run_scoped(
    rt,
    reporter,
    *,
    paths,
    family_key,
    previous_path=None,
    expected_hashes=None,
    embedder=None,
):
    if len(paths) != 1:
        raise ValueError("One immutable version per scoped task is required")
    async with rt.ingest_lock:
        path = checked_path(rt.root, paths[0])
        current = await registry(rt.storage)
        if current.get(family_key) not in {previous_path, path}:
            raise ValueError("Source version changed; refresh before indexing")
        hashes = expected_hashes or {}
        before = hashlib.sha256((rt.root / path).read_bytes()).hexdigest()
        if hashes.get(path) and hashes[path] != before:
            raise ValueError("Imported source hash no longer matches")
        await stage(rt.storage, family_key, path)
        cfg = load_config(rt.root / CONFIG_FILENAME)
        if cfg.assets.multimodal is not None:
            raise ValueError(
                "Folder PDF indexing requires text-only source configuration"
            )
        document_id = doc_id_for(Layer.SOURCE, path)
        existing = await rt.storage.get_document(document_id)
        parsed = api_ingest.parse_any(rt.root / path, rel_path=path)
        if existing and existing.active and existing.hash != parsed.hash:
            raise ValueError(
                "An indexed immutable source was overwritten; import a new version path instead"
            )
        active_version = await _resolve_active_text_version_for_inline_embed(
            rt.storage, cfg.provider
        )
        if existing and active_version:
            chunks = await rt.storage.list_chunks(document_id)
            missing = await rt.storage.list_chunks_missing_embedding(
                version_id=active_version[0]
            )
            if (
                existing.hash == parsed.hash
                and chunks
                and not any(c.doc_id == document_id for c in missing)
            ):
                reporter.cancel_token().raise_if_cancelled()
                await promote(rt.storage, family_key, path, previous_path)
                return {
                    "scanned": 1,
                    "added": 0,
                    "updated": 0,
                    "unchanged": 1,
                    "chunks": 0,
                    "embedded": 0,
                    "errors": [],
                    "scoped": True,
                    "paths": paths,
                    "promotedPath": path,
                    "previousPath": previous_path,
                    "familyKey": family_key,
                }
        owned = embedder is None
        embedder = embedder if embedder is not None else build_embedder(cfg.provider)
        try:
            engine = scoped_engine(set(paths), set(current.values()))
            report = await engine(rt.root, embedder=embedder, reporter=reporter)
            if report.errors or report.scanned != 1:
                raise ValueError("The selected source was not fully indexed")
            version = await rt.storage.get_active_embed_version(modality="text")
            if not version or version.version_id is None:
                raise ValueError(
                    "The selected source has no confirmed embedding version"
                )
            document_id = doc_id_for(Layer.SOURCE, path)
            if not await rt.storage.list_chunks(document_id):
                raise ValueError("The selected source produced no searchable content")
            missing = await rt.storage.list_chunks_missing_embedding(
                version_id=version.version_id
            )
            if any(c.doc_id == document_id for c in missing):
                raise ValueError(
                    "The selected source has incomplete embeddings; the previous version remains available"
                )
            if (
                hashlib.sha256(
                    (rt.root / checked_path(rt.root, path)).read_bytes()
                ).hexdigest()
                != before
            ):
                raise ValueError(
                    "Source changed during indexing; the previous version remains available"
                )
            reporter.cancel_token().raise_if_cancelled()
            await promote(rt.storage, family_key, path, previous_path)
            return {
                **dataclasses.asdict(report),
                "scoped": True,
                "paths": paths,
                "promotedPath": path,
                "previousPath": previous_path,
                "familyKey": family_key,
            }
        finally:
            if owned and hasattr(embedder, "aclose"):
                await embedder.aclose()


class Submit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paths: list[str] = Field(min_length=1, max_length=1)
    familyKey: str = Field(pattern=r"^[a-f0-9]{64}$")
    previousPath: str | None = Field(None, max_length=2000)
    expectedHashes: dict[str, str] = Field(default_factory=dict)


async def run_incremental(rt, reporter, *, no_embed=False, embedder=None):
    """Explicit whole-base ingest skips staged/superseded folder versions.

    This keeps the existing ingest endpoint usable without allowing a later
    global scan to reactivate an old version or a failed staged replacement.
    """
    async with rt.ingest_lock:
        cfg = load_config(rt.root / CONFIG_FILENAME)
        excluded = await inactive_versions(rt.storage)
        current = set((await registry(rt.storage)).values())
        # A raw automatic-import placeholder can land before its first scoped
        # task. Global ingest must not register that unparsed/new version.
        for absolute, logical in iter_source_files(cfg.sources, root=rt.root):
            if logical in current:
                continue
            if absolute.suffix.lower() == ".md":
                try:
                    with absolute.open("r", encoding="utf-8") as source:
                        header = source.read(4096)
                except (OSError, UnicodeError):
                    continue  # Ordinary Core ingest records this file's error.
                if re.search(
                    r'^source_kind:\s*["\x27]?folder-import["\x27]?\s*$',
                    header,
                    re.MULTILINE,
                ):
                    excluded.add(logical)
        paths = {
            logical
            for _, logical in iter_source_files(cfg.sources, root=rt.root)
            if logical not in excluded
        }
        owned = embedder is None and not no_embed
        if owned:
            embedder = build_embedder(cfg.provider)
        try:
            result = await scoped_engine(paths, paths, full=True, excluded=excluded)(
                rt.root, embedder=embedder, reporter=reporter
            )
            return dataclasses.asdict(result)
        finally:
            if owned and hasattr(embedder, "aclose"):
                await embedder.aclose()


def install(app, auth):
    """Add routes with the exact same Core server-to-server authorization."""
    if getattr(app.state, "folder_extension", False):
        return app
    verify_ingest_contract()
    router = APIRouter(
        prefix="/v1/folder-import", dependencies=[Depends(make_dependency(auth))]
    )
    submission_lock = asyncio.Lock()

    @router.get("/capabilities")
    async def capabilities(request: Request):
        storage = get_runtime(request.app).storage
        compatible = is_sqlite(storage) or is_postgres(storage)
        return {
            "version": 1,
            "scopedIngest": compatible,
            "atomicVersionPromotion": compatible,
            "manualOriginalDelete": compatible,
            "maxPaths": 1,
        }

    @router.post("/discard-manual-original")
    async def discard_manual_original(request: Request, body: ManualOriginal):
        rt = get_runtime(request.app)
        if body.path not in (
            f"sources/upload-{body.sha256[:21]}.md",
            f"sources/upload-{body.sha256}.md",
        ):
            raise HTTPException(409, "原件路径与上传记录不一致")
        async with rt.ingest_lock:
            if (
                await rt.storage.get_document(doc_id_for(Layer.SOURCE, body.path))
                is not None
            ):
                raise HTTPException(409, "资料已有知识库记录，请刷新后使用全库删除")
            result = await asyncio.to_thread(discard_manual_files, rt.root, body)
            return {"path": body.path, **result}

    @router.post("/ingest")
    async def submit(request: Request, body: Submit):
        rt = get_runtime(request.app)
        try:
            for path in body.paths:
                checked_path(rt.root, path)
            if body.previousPath:
                checked_path(rt.root, body.previousPath)
            if any(
                p not in body.paths or not re.fullmatch(r"[a-f0-9]{64}", h)
                for p, h in body.expectedHashes.items()
            ):
                raise ValueError("Invalid expected source hash")
        except (OSError, ValueError) as exc:
            raise HTTPException(422, "Invalid or unavailable imported source") from exc

        async def runner(reporter):
            return await run_scoped(
                rt,
                reporter,
                paths=body.paths,
                family_key=body.familyKey,
                previous_path=body.previousPath,
                expected_hashes=body.expectedHashes,
            )

        async with submission_lock:
            params = body.model_dump()
            digest = _params_digest(params)
            # Recover a handle even if the response was lost before the BFF
            # persisted it. Failed jobs may be explicitly retried; successful
            # historical jobs never promote an old version a second time.
            cursor = {}
            while True:
                rows = await rt.task_store.list_tasks(
                    op="folder.ingest", limit=100, **cursor
                )
                for old in rows:
                    if old.params_digest != digest:
                        continue
                    if old.status.value in {"pending", "running"}:
                        return _handle(old)
                    if old.status.value == "succeeded":
                        # Only deduplicate against a historical success when every
                        # target path is still the currently active promoted version.
                        # Re-promoting a version after a revert (v1->v2->v1->v2)
                        # must run a fresh ingest/promote cycle.
                        inactive = await inactive_versions(rt.storage)
                        still_active = True
                        for path in body.paths:
                            if path in inactive:
                                still_active = False
                                break
                            doc = await rt.storage.get_document(
                                doc_id_for(Layer.SOURCE, path)
                            )
                            if doc is None or not doc.active:
                                still_active = False
                                break
                        if still_active:
                            return _handle(old)
                if len(rows) < 100:
                    break
                cursor = {
                    "after_created_at": rows[-1].created_at,
                    "after_task_id": rows[-1].task_id,
                }
            row = await rt.manager.submit(
                op="folder.ingest", runner=runner, params=params, base_id=rt.base_id
            )
            return _handle(row)

    @router.get("/version")
    async def read_version(request: Request, path: str = Query(max_length=2000)):
        rt = get_runtime(request.app)
        try:
            checked_path(rt.root, path)
            await registry(rt.storage)
            if is_sqlite(rt.storage):
                proven = await rt.storage._locked(
                    lambda: bool(
                        rt.storage._require_conn()
                        .execute(
                            "SELECT 1 FROM mberp_folder_versions WHERE path=?", (path,)
                        )
                        .fetchone()
                    )
                )
            else:
                async with rt.storage._acquire() as connection:
                    result = await connection.execute(
                        "SELECT 1 FROM mberp_folder_versions WHERE path=%s", (path,)
                    )
                    proven = bool(await result.fetchone())
            if not proven:
                raise ValueError("Unknown version")
            raw = (rt.root / path).read_bytes()
            if len(raw) > 9 * 1024 * 1024:
                raise ValueError("Source is too large")
            return {
                "path": path,
                "content": raw.decode("utf-8"),
                "historical": path in await inactive_versions(rt.storage),
            }
        except (OSError, UnicodeError, ValueError) as exc:
            raise HTTPException(404, "Source version is unavailable") from exc

    # Match the HTTP ingest path first. FastAPI can keep included routers as
    # groups rather than small path-bearing routes, so filtering the outer
    # list for '/v1/ingest' can leave the unguarded upstream handler in place.
    # Installed engine APIs remain unchanged.
    guarded = APIRouter(dependencies=[Depends(make_dependency(auth))])

    @guarded.post("/v1/ingest", response_model=TaskHandle, include_in_schema=False)
    async def global_ingest(
        request: Request, body: IngestSubmit = Body(default_factory=IngestSubmit)
    ) -> TaskHandle:
        rt = get_runtime(request.app)

        async def runner(reporter):
            return await run_incremental(rt, reporter, no_embed=body.no_embed)

        return _handle(
            await rt.manager.submit(
                op="ingest",
                runner=runner,
                params={"no_embed": body.no_embed},
                base_id=rt.base_id,
            )
        )

    route_count = len(app.router.routes)
    app.include_router(guarded)
    guarded_routes = app.router.routes[route_count:]
    app.router.routes[:] = guarded_routes + app.router.routes[:route_count]
    app.include_router(router)
    app.state.folder_extension = True
    return app
