"""Offline contract tests: no local IAM, private configuration or credentials."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

import httpx


SPEC = importlib.util.spec_from_file_location(
    "local_iam_theme", Path(__file__).with_name("apply-local-theme.py")
)
theme = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(theme)


class LocalThemeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "local-config.json"
        self.control = {
            "owner": "admin", "name": "mp-pm", "organization": "mabpharm",
            "clientId": "test-local-control", "clientSecret": "synthetic-control-value",
        }
        self.config.write_text(json.dumps({"applications": [self.control]}))
        self.patch = self.root / "patch.json"
        self.patch.write_text(json.dumps({
            "themeData": {"colorPrimary": "#1e466b"},
            "formCss": ".login { color: #1e466b; }",
            "formCssMobile": ".login { color: #1e466b; }",
        }))
        self.backup = self.root / "private"
        self.originals = {}
        for name in theme.APPLICATIONS:
            record = {
                **self.control, "name": name,
                "clientSecret": (self.control["clientSecret"] if name == "mp-pm"
                                 else "synthetic-knowledge-value"),
                "redirectUris": ["http://localhost:1234/auth/callback"],
                "themeData": {"retainedSetting": True, "colorPrimary": "#0f3b27"},
                "formCss": "old desktop", "formCssMobile": "old mobile",
                "optionalField": None,
            }
            self.originals[name] = record
        self.actual = copy.deepcopy(self.originals)
        self.requests = []

    def tearDown(self):
        self.temp.cleanup()

    def handler(self, request):
        self.requests.append(request)
        self.assertEqual(request.url.scheme, "http")
        self.assertEqual(request.url.host, "localhost")
        self.assertEqual(request.url.port, 8001)
        owner, name = request.url.params["id"].split("/")
        self.assertEqual(owner, "admin")
        self.assertIn(name, theme.APPLICATIONS)
        if request.method == "POST":
            self.assertEqual(request.url.path, "/api/update-application")
            self.actual[name] = json.loads(request.content)
            return httpx.Response(200, json={"status": "ok", "data": None})
        self.assertEqual(request.url.path, "/api/get-application")
        return httpx.Response(200, json={"status": "ok", "data": self.actual[name]})

    def apply(self, handler=None, **kwargs):
        return theme.apply_theme(
            self.config, kwargs.pop("backup_dir", self.backup),
            patch_path=kwargs.pop("patch_path", self.patch),
            transport=httpx.MockTransport(handler or self.handler), **kwargs,
        )

    def receipt(self):
        return json.loads(next(self.backup.glob("*/receipt.json")).read_text())

    def test_bundled_css_patch_matches_the_source_style(self):
        directory = Path(__file__).parent
        bundled = theme.load_patch(directory / "application-theme.patch.json")
        source = (directory / "forest-login.css").read_text(encoding="utf-8").strip()
        for key in ("formCss", "formCssMobile"):
            wrapped = bundled[key].strip()
            self.assertTrue(wrapped.startswith("<style>"))
            self.assertTrue(wrapped.endswith("</style>"))
            self.assertEqual(wrapped[len("<style>"):-len("</style>")].strip(), source)

    def test_theme_only_update_preserves_other_fields_and_private_backups(self):
        receipt = self.apply()
        self.assertTrue(receipt["completed"])
        for name, original in self.originals.items():
            self.assertEqual(
                {k: v for k, v in self.actual[name].items() if k not in theme.THEME_FIELDS},
                {k: v for k, v in original.items() if k not in theme.THEME_FIELDS},
            )
            self.assertTrue(self.actual[name]["themeData"]["retainedSetting"])
            self.assertEqual(self.actual[name]["themeData"]["colorPrimary"], "#1e466b")
        self.assertEqual([r.method for r in self.requests[:2]], ["GET", "GET"])
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o700)
        for path in self.backup.rglob("*"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        encoded_receipt = json.dumps(self.receipt())
        self.assertNotIn(self.control["clientSecret"], encoded_receipt)
        self.assertNotIn("redirectUris", encoded_receipt)

    def test_patch_with_non_theme_field_is_rejected_before_requests(self):
        data = json.loads(self.patch.read_text())
        data["redirectUris"] = ["https://not-allowed.invalid"]
        self.patch.write_text(json.dumps(data))
        with self.assertRaises(theme.LocalThemeError):
            self.apply()
        self.assertEqual(self.requests, [])

    def test_ambiguous_control_application_is_rejected(self):
        self.config.write_text(json.dumps({"applications": [self.control, self.control]}))
        with self.assertRaises(theme.LocalThemeError):
            self.apply()
        self.assertEqual(self.requests, [])

    def test_masked_or_wrong_organization_record_blocks_both_writes(self):
        for change in ({"clientSecret": "***"}, {"organization": "other"}):
            with self.subTest(change=change):
                self.actual = copy.deepcopy(self.originals)
                self.actual["dikw-kb-local"].update(change)
                self.requests.clear()
                with self.assertRaises(theme.LocalThemeError):
                    self.apply()
                self.assertFalse(any(r.method == "POST" for r in self.requests))

    def test_non_theme_readback_mismatch_restores_all_attempted_writes(self):
        corrupt_once = True

        def handler(request):
            nonlocal corrupt_once
            response = self.handler(request)
            name = request.url.params["id"].split("/")[1]
            if (request.method == "POST" and name == "dikw-kb-local" and corrupt_once):
                corrupt_once = False
                self.actual[name]["redirectUris"] = ["http://changed.invalid"]
            return response

        with self.assertRaisesRegex(theme.LocalThemeError, "restored and verified"):
            self.apply(handler)
        self.assertEqual(self.actual, self.originals)
        self.assertEqual(self.receipt()["rollback_verified"], True)

    def test_missing_vs_null_other_field_is_not_treated_as_preserved(self):
        corrupt_once = True

        def handler(request):
            nonlocal corrupt_once
            response = self.handler(request)
            if request.method == "POST" and corrupt_once:
                corrupt_once = False
                del self.actual["mp-pm"]["optionalField"]
            return response

        with self.assertRaisesRegex(theme.LocalThemeError, "restored and verified"):
            self.apply(handler)
        self.assertEqual(self.actual, self.originals)

    def test_failed_readback_restores_written_record(self):
        fail_next_read = False
        failed = False

        def handler(request):
            nonlocal fail_next_read, failed
            if request.method == "GET" and fail_next_read:
                self.requests.append(request)
                fail_next_read = False
                failed = True
                return httpx.Response(503, json={"status": "error"})
            response = self.handler(request)
            if request.method == "POST" and not failed:
                fail_next_read = True
            return response

        with self.assertRaisesRegex(theme.LocalThemeError, "restored and verified"):
            self.apply(handler)
        self.assertEqual(self.actual, self.originals)

    def test_rollback_failure_is_visible_without_response_or_credentials(self):
        posts = 0

        def handler(request):
            nonlocal posts
            if request.method == "POST":
                posts += 1
                if posts > 1:
                    self.requests.append(request)
                    return httpx.Response(503, json={"status": "error", "message": "sensitive response"})
            response = self.handler(request)
            if request.method == "POST":
                self.actual["mp-pm"]["redirectUris"] = []
            return response

        with self.assertRaisesRegex(theme.LocalThemeError, "rollback could not be verified") as caught:
            self.apply(handler)
        self.assertNotIn("sensitive response", str(caught.exception))
        self.assertNotIn(self.control["clientSecret"], str(caught.exception))
        self.assertFalse(self.receipt()["rollback_verified"])

    def test_external_redirect_is_never_followed(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(302, headers={"Location": "https://outside.invalid/collect"})

        with self.assertRaises(theme.LocalThemeError):
            self.apply(handler)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].url.host, "localhost")

    def test_git_backup_directory_must_be_ignored(self):
        repo = self.root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(repo)], check=True, capture_output=True)
        with self.assertRaisesRegex(theme.LocalThemeError, "Git-ignored"):
            self.apply(backup_dir=repo / "backups")
        self.assertEqual(self.requests, [])
        (repo / ".gitignore").write_text("private/\n")
        receipt = self.apply(backup_dir=repo / "private")
        self.assertTrue(receipt["completed"])

    def test_existing_backup_with_public_permissions_is_refused(self):
        self.backup.mkdir(mode=0o755)
        os.chmod(self.backup, 0o755)
        with self.assertRaisesRegex(theme.LocalThemeError, "0700"):
            self.apply()
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
