import importlib.util
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "folder_connector", Path(__file__).with_name("knowledge-folder-connector.py")
)
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def test_authorized_paths_and_symlink_escape(self):
        (self.root / "normal.pdf").write_bytes(b"%PDF-1.7\ntext")
        for unsafe in (
            "../normal.pdf",
            "/etc/secret.pdf",
            "a/../../secret.pdf",
            "a\\b.pdf",
            "C:/secret.pdf",
        ):
            with self.assertRaises(connector.ConnectorError):
                connector.open_file(self.root, unsafe)
        outside = self.root.parent / (self.root.name + "-outside.pdf")
        try:
            outside.write_bytes(b"%PDF-1.7\noutside")
            (self.root / "linked.pdf").symlink_to(outside)
            with self.assertRaises(connector.ConnectorError):
                connector.open_file(self.root, "linked.pdf")
            records, _, _, _ = connector.manifest(self.root, {}, stable_seconds=0)
            self.assertEqual([r["relativePath"] for r in records], ["normal.pdf"])
        finally:
            outside.unlink(missing_ok=True)

    def test_manifest_ten_unique_files_and_batch_cursor(self):
        for i in range(10):
            (self.root / f"document-{i}.pdf").write_bytes(
                f"%PDF-1.7\nUnique content {i}".encode()
            )
        records, errors, truncated, cursor = connector.manifest(
            self.root, {}, stable_seconds=0
        )
        self.assertEqual(len(records), 10)
        self.assertEqual(len({r["sha256"] for r in records}), 10)
        self.assertFalse(errors)
        self.assertFalse(truncated)
        first, _, partial, cursor = connector.manifest(
            self.root, {"maxFilesPerScan": 4}, stable_seconds=0
        )
        second, _, _, cursor = connector.manifest(
            self.root, {"maxFilesPerScan": 4}, cursor, stable_seconds=0
        )
        third, _, _, _ = connector.manifest(
            self.root, {"maxFilesPerScan": 4}, cursor, stable_seconds=0
        )
        self.assertTrue(partial)
        self.assertEqual(len({r["relativePath"] for r in first + second + third}), 10)

    def test_unstable_file_does_not_upload(self):
        path = self.root / "writing.pdf"
        path.write_bytes(b"%PDF-1.7\nold")
        with patch.object(
            connector.time,
            "sleep",
            side_effect=lambda _: path.write_bytes(b"%PDF-1.7\nnew longer content"),
        ):
            records, errors, _, _ = connector.manifest(self.root, {}, stable_seconds=2)
        self.assertFalse(records)
        self.assertEqual(errors[0]["relativePath"], "writing.pdf")

    def test_state_is_private_and_server_does_not_follow_redirect(self):
        destination = self.root / "private" / "connector.json"
        connector.save_state(
            destination,
            {
                "server": "https://www.openlims.ai",
                "token": "test-only-token",
                "folder": str(self.root),
            },
        )
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        self.assertEqual(connector.load_state(destination)["token"], "test-only-token")
        for unsafe in (
            "http://public.test",
            "https://a.test/path",
            "https://user:pass@a.test",
            "https://a.test?token=x",
        ):
            with self.assertRaises(connector.ConnectorError):
                connector.server_origin(unsafe)

        class Response:
            status = 307

            def read(self, _):
                return b""

        class Connection:
            def getresponse(self):
                return Response()

        with self.assertRaises(connector.ConnectorError):
            connector.Client.response(Connection())

    def test_server_cannot_request_unlisted_file(self):
        path = self.root / "listed.pdf"
        path.write_bytes(b"%PDF-1.7\nlisted")

        class Client:
            def post(self, route, data, lease=None):
                if route == "/poll":
                    return {"task": {}, "run": {"id": "run", "lease": "lease"}}
                return {"needFiles": ["../outside.pdf"]}

        with patch.object(connector.time, "sleep"):
            with self.assertRaises(connector.ConnectorError):
                connector.run_once(
                    Client(), {"folder": str(self.root)}, self.root / "state.json"
                )

    def test_same_config_cannot_run_twice(self):
        state = self.root / "state.json"
        with connector.single_instance(state):
            with self.assertRaises(connector.ConnectorError):
                with connector.single_instance(state):
                    self.fail("second connector acquired the same state")
        with connector.single_instance(state):
            pass


if __name__ == "__main__":
    unittest.main()
