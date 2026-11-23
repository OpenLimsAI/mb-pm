"""Real Core/storage acceptance; temporary bases, deterministic local embeddings."""

import asyncio
import functools
import hashlib
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
from fastapi import FastAPI

from dikw_core import api
from dikw_core.config import CONFIG_FILENAME, load_config, dump_config_yaml
from dikw_core.domains.data.path_norm import doc_id_for
from dikw_core.progress import NoopReporter
from dikw_core.schemas import Layer
from dikw_core.server.auth import AuthConfig
from dikw_core.server.errors import install_handlers
from dikw_core.server.runtime import build_runtime, teardown_runtime
from folder_core import (
    checked_path,
    install,
    registry,
    run_incremental,
    run_scoped,
    scoped_engine,
    verify_ingest_contract,
)


class Embedder:
    def __init__(self, fail=False):
        self.texts = []
        self.fail = fail

    async def embed(self, texts, *, model):
        if self.fail:
            raise ValueError("test embedding unavailable")
        self.texts.extend(texts)
        return [[1.0, 0.0, 0.0, 0.0] for text in texts]


class CoreAcceptance(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = api.init_base(Path(self.temporary.name))
        cfg = load_config(self.root / CONFIG_FILENAME)
        cfg.provider.embedding_dim = 4
        cfg.provider.embedding_model = "folder-test-local"
        cfg.provider.embedding_base_url = "http://127.0.0.1:9/v1"
        cfg.provider.embedding_error_retries = 0
        (self.root / CONFIG_FILENAME).write_text(dump_config_yaml(cfg))
        self.rt = await build_runtime(
            root=self.root, auth=AuthConfig(host="127.0.0.1", token=None)
        )

    async def asyncTearDown(self):
        await teardown_runtime(self.rt)
        self.temporary.cleanup()

    def write(self, name, text):
        path = "sources/" + name + ".md"
        (self.root / path).write_text("# " + name + "\n\n" + text, encoding="utf-8")
        return path

    async def index(self, path, family, previous=None, embedder=None):
        return await run_scoped(
            self.rt,
            NoopReporter(),
            paths=[path],
            family_key=hashlib.sha256(family.encode()).hexdigest(),
            previous_path=previous,
            embedder=embedder or Embedder(),
        )

    async def test_ten_distinct_sources_and_no_unrelated_work(self):
        unrelated = self.write("unrelated", "UNRELATED_PENDING_DOCUMENT")
        embedder = Embedder()
        for i in range(10):
            path = self.write(
                f"document-{i}",
                f"Unique experiment testtoken{i} result is {i * 11 + 3}.",
            )
            proof = await self.index(path, f"family-{i}", embedder=embedder)
            self.assertTrue(proof["scoped"])
            self.assertEqual(proof["scanned"], 1)
            document = await self.rt.storage.get_document(
                doc_id_for(Layer.SOURCE, path)
            )
            self.assertTrue(document.active)
            hits = await self.rt.storage.fts_search(f"testtoken{i}", limit=10)
            self.assertTrue(hits, f"document {i} must be searchable")
        self.assertEqual(len(await registry(self.rt.storage)), 10)
        self.assertIsNone(
            await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, unrelated))
        )
        self.assertFalse(
            any("UNRELATED_PENDING_DOCUMENT" in text for text in embedder.texts)
        )

    async def test_version_promotes_only_after_embedding_and_keeps_originals(self):
        old = self.write(
            "v1",
            "OLD_VERSION_TOKEN first version remains available until replacement is ready.",
        )
        await self.index(old, "document")
        new = self.write(
            "v2", "NEW_VERSION_TOKEN revised version contains a different finding."
        )
        with self.assertRaises(ValueError):
            await self.index(new, "document", old, Embedder(fail=True))
        self.assertTrue(
            (await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, old))).active
        )
        self.assertFalse(
            (await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, new))).active
        )
        await self.index(new, "document", old)
        self.assertFalse(
            (await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, old))).active
        )
        self.assertTrue(
            (await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, new))).active
        )
        self.assertTrue((self.root / old).is_file())
        self.assertTrue(await self.rt.storage.fts_search("NEW_VERSION_TOKEN", limit=10))
        self.assertFalse(
            await self.rt.storage.fts_search("OLD_VERSION_TOKEN", limit=10)
        )
        with self.assertRaises(ValueError):
            await self.index(old, "document")
        unrelated = self.write(
            "global-pending",
            "Other sources are processed only by the explicit global operation.",
        )
        await run_incremental(self.rt, NoopReporter(), embedder=Embedder())
        self.assertFalse(
            (await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, old))).active
        )
        self.assertTrue(
            (
                await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, unrelated))
            ).active
        )

    async def test_unchanged_version_reuses_embeddings(self):
        path = self.write(
            "same", "The same content must not cause another paid embedding operation."
        )
        await self.index(path, "same")
        embedder = Embedder()
        proof = await self.index(path, "same", embedder=embedder)
        self.assertEqual(proof["unchanged"], 1)
        self.assertEqual(embedder.texts, [])

    async def test_global_ingest_skips_unparsed_automatic_placeholder(self):
        path = self.write(
            "automatic-pending",
            "Only the scoped importer may publish this placeholder.",
        )
        (self.root / path).write_text(
            '---\nsource_kind: "folder-import"\ntext_extracted: false\n---\n\n# Pending\n\nOriginal is saved; parsing has not completed.'
        )
        ordinary = self.write(
            "ordinary-pending",
            "An ordinary manual source still participates in explicit global ingest.",
        )
        await run_incremental(self.rt, NoopReporter(), embedder=Embedder())
        self.assertIsNone(
            await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, path))
        )
        self.assertTrue(
            (
                await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, ordinary))
            ).active
        )

    async def test_active_immutable_path_cannot_be_overwritten_during_reindex(self):
        path = self.write(
            "immutable",
            "Original indexed version stays visible until a new version path is ready.",
        )
        await self.index(path, "immutable")
        before = (
            await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, path))
        ).hash
        self.write(
            "immutable",
            "This external overwrite must never replace the active index in place.",
        )
        with self.assertRaises(ValueError):
            await self.index(path, "immutable")
        document = await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, path))
        self.assertTrue(document.active)
        self.assertEqual(document.hash, before)

    async def test_path_and_source_hash_validation(self):
        for path in ("../secret.md", "/etc/secret.md", "sources/../secret.md"):
            with self.assertRaises((ValueError, OSError)):
                checked_path(self.root, path)
        path = self.write("valid", "Original source text is immutable during indexing.")
        with self.assertRaises(ValueError):
            await run_scoped(
                self.rt,
                NoopReporter(),
                paths=[path],
                family_key="a" * 64,
                expected_hashes={path: "0" * 64},
                embedder=Embedder(),
            )
        self.assertIsNone(
            await self.rt.storage.get_document(doc_id_for(Layer.SOURCE, path))
        )

    async def test_http_auth_handle_recovery_and_history(self):
        app = FastAPI()
        install_handlers(app)
        app.state.runtime = self.rt
        install(app, AuthConfig(host="127.0.0.1", token="test-only-folder-token"))
        path = self.write(
            "http",
            "The dedicated endpoint must retain its task handle after a lost response.",
        )
        body = {"paths": [path], "familyKey": "d" * 64}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://core.test"
        ) as client:
            self.assertEqual(
                (await client.get("/v1/folder-import/capabilities")).status_code, 401
            )
            headers = {"Authorization": "Bearer test-only-folder-token"}
            self.assertTrue(
                (
                    await client.get("/v1/folder-import/capabilities", headers=headers)
                ).json()["scopedIngest"]
            )
            with patch("folder_core.build_embedder", return_value=Embedder()):
                first = await client.post(
                    "/v1/folder-import/ingest", json=body, headers=headers
                )
                self.assertEqual(first.status_code, 200, first.text)
                second = await client.post(
                    "/v1/folder-import/ingest", json=body, headers=headers
                )
                self.assertEqual(first.json()["task_id"], second.json()["task_id"])
                task_id = first.json()["task_id"]
                for _ in range(100):
                    task = await self.rt.task_store.get(task_id)
                    if task.status.value in {"succeeded", "failed"}:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(task.status.value, "succeeded", task.error)
                self.assertTrue(task.result["scoped"])
            version = await client.get(
                "/v1/folder-import/version", params={"path": path}, headers=headers
            )
            self.assertEqual(version.status_code, 200)
            self.assertIn("dedicated endpoint", version.json()["content"])

    async def test_discard_pending_manual_upload_without_embedding(self):
        app = FastAPI()
        install_handlers(app)
        app.state.runtime = self.rt
        install(app, AuthConfig(host="127.0.0.1", token="test-only-folder-token"))
        url = "/v1/folder-import/discard-manual-original"
        headers = {"Authorization": "Bearer test-only-folder-token"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://core.test"
        ) as client:
            for shared in (False, True):
                original = f"%PDF-1.7\nSynthetic pending upload {shared}".encode()
                sha = hashlib.sha256(original).hexdigest()
                pdf = self.root / "sources" / f"{sha}.pdf"
                md = self.root / "sources" / f"upload-{sha[:21]}.md"
                pdf.write_bytes(original)
                content = (
                    f'---\nsource_kind: "manual-upload"\noriginal_sha256: "{sha}"\n---\n'
                    f"# Pending upload\n<!-- ![PDF]({sha}.pdf) -->\n"
                ).encode()
                md.write_bytes(content)
                if shared:
                    self.write("other-source", f"![PDF]({sha}.pdf)")
                body = {
                    "path": f"sources/{md.name}",
                    "sha256": sha,
                    "sourceHash": hashlib.sha256(content).hexdigest(),
                }
                self.assertEqual((await client.post(url, json=body)).status_code, 401)
                mismatch = await client.post(
                    url, json={**body, "sourceHash": "a" * 64}, headers=headers
                )
                self.assertEqual(mismatch.status_code, 409)
                self.assertTrue(md.is_file() and pdf.is_file())
                deleted = await client.post(url, json=body, headers=headers)
                self.assertEqual(deleted.status_code, 200, deleted.text)
                self.assertEqual(deleted.json()["sharedOriginalRetained"], shared)
                self.assertFalse(md.exists())
                self.assertEqual(pdf.exists(), shared)
                self.assertEqual(
                    (await client.post(url, json=body, headers=headers)).json(),
                    deleted.json(),
                )
                self.assertIsNone(
                    await self.rt.storage.get_document(
                        doc_id_for(Layer.SOURCE, f"sources/{md.name}")
                    )
                )
                if not shared:
                    # Re-import and register the same source before confirming a retry.
                    md.write_bytes(content)
                    pdf.write_bytes(original)
                    await self.index(f"sources/{md.name}", "deleted-and-reimported")
                    conflict = await client.post(url, json=body, headers=headers)
                    self.assertEqual(conflict.status_code, 409)
                    self.assertTrue(md.is_file() and pdf.is_file())

    async def test_verify_ingest_contract_and_scoped_engine_unwrap_decorated_ingest(self):
        fake_module = types.ModuleType("fake_dikw_ingest")

        def default_iter_source_files(sources_cfg, *, root):
            return iter(
                [
                    (root / "sources" / "alpha.md", "sources/alpha.md"),
                    (root / "sources" / "beta.md", "sources/beta.md"),
                ]
            )

        async def default_with_storage(path):
            cfg = types.SimpleNamespace(sources="sources")
            return cfg, Path(path), MagicMock(name="raw_storage")

        def traced_decorator(fn):
            @functools.wraps(fn)
            async def wrapper(*args, **kwargs):
                return await fn(*args, **kwargs)

            return wrapper

        async def raw_ingest(path, *, embedder=None, reporter=None):
            cfg, root, storage = await _with_storage(path)  # noqa: F821
            visited = [logical for _, logical in iter_source_files(cfg.sources, root=root)]  # noqa: F821
            return {
                "visited": visited,
                "storage_type": type(storage).__name__,
                "embedder": embedder,
            }

        fake_module.iter_source_files = default_iter_source_files
        fake_module._with_storage = default_with_storage
        inner_ingest = types.FunctionType(
            raw_ingest.__code__,
            fake_module.__dict__,
            name="ingest",
            argdefs=raw_ingest.__defaults__,
            closure=raw_ingest.__closure__,
        )
        inner_ingest.__kwdefaults__ = dict(raw_ingest.__kwdefaults__ or {})
        fake_module.ingest = traced_decorator(inner_ingest)

        unwrapped = verify_ingest_contract(fake_module, version_str="0.6.10")
        self.assertIs(unwrapped, inner_ingest)

        alpha = self.write("alpha", "Alpha content")
        beta = self.write("beta", "Beta content")
        with patch("folder_core.iter_source_files", default_iter_source_files), patch(
            "folder_core._with_storage", default_with_storage
        ):
            scoped_fn = scoped_engine({beta}, {beta}, ingest_module=fake_module)
            result = await scoped_fn(self.root, embedder="mock-embedder")
        self.assertEqual(
            result,
            {
                "visited": [beta],
                "storage_type": "ScopedStorage",
                "embedder": "mock-embedder",
            },
        )
        upstream_result = await fake_module.ingest(self.root)
        self.assertEqual(upstream_result["visited"], [alpha, beta])


if __name__ == "__main__":
    unittest.main()
