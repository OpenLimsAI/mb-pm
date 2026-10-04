"""Security and proxy regression tests; no production IAM users/data are modified."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient
import httpx
from jose import jwt


work = tempfile.TemporaryDirectory()
config = {
    "public_url": "https://kb.example.test", "issuer": "https://iam.example.test",
    "iam_internal_url": "http://iam:8000", "core_url": "http://core:8765", "web_url": "http://web:4321",
    "organization": "test-org", "client_id": "kb-test", "client_secret": "test-client-secret",
    "core_token": "server-only-test-token", "session_secret": "test-session-secret",
}
config_file = Path(work.name) / "config.json"
config_file.write_text(json.dumps(config))
os.environ["KB_CONFIG_FILE"] = str(config_file)
os.environ["KB_SESSION_DB"] = str(Path(work.name) / "sessions.sqlite")
spec = importlib.util.spec_from_file_location("gateway", Path(__file__).with_name("app.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
private_key = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
numbers = key.public_key().public_numbers()
def b64int(n):
    return base64.urlsafe_b64encode(n.to_bytes((n.bit_length()+7)//8, "big")).rstrip(b"=").decode()
jwk = {"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "test-key", "n": b64int(numbers.n), "e": b64int(numbers.e)}


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.mode = "ok"
        self.user = {"id": "user-id", "name": "user", "owner": "test-org", "displayName": "测试用户", "isForbidden": False}
        self.sent = []
        self.client = TestClient(gateway.app, base_url=config["public_url"])
        self.client.__enter__()
        self.previous_http = gateway._http
        gateway._http = httpx.AsyncClient(transport=httpx.MockTransport(self.handle), trust_env=False)
        gateway._jwks = (0, {})
        with gateway.db() as conn:
            conn.execute("DELETE FROM sessions")
            conn.execute("DELETE FROM oauth")

    def tearDown(self):
        self.client.portal.call(gateway._http.aclose)
        gateway._http = self.previous_http
        self.client.__exit__(None, None, None)

    def handle(self, request):
        if request.url.host == "iam":
            if request.url.path == "/.well-known/jwks":
                return httpx.Response(200, json={"keys": [jwk]})
            if request.url.path == "/api/get-user":
                if self.mode == "iam-down":
                    return httpx.Response(503)
                return httpx.Response(200, json={"status": "ok", "data": self.user})
            if request.url.path == "/api/login/oauth/access_token":
                claims = {"sub": "user-id", "aud": "kb-test", "iss": config["issuer"], "exp": int(time.time()) + 3600, "iat": int(time.time()), "owner": "test-org"}
                if self.mode == "wrong-org": claims["owner"] = "other-org"
                if self.mode == "wrong-aud": claims["aud"] = "other-app"
                if self.mode == "expired": claims["exp"] = int(time.time()) - 60
                signing_key = private_key
                if self.mode == "forged":
                    signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
                access = jwt.encode(claims, signing_key, algorithm="RS256", headers={"kid": "test-key"})
                identity = dict(claims, nonce="bad" if self.mode == "wrong-nonce" else self.nonce)
                identity["at_hash"] = base64.urlsafe_b64encode(__import__('hashlib').sha256(access.encode()).digest()[:16]).rstrip(b"=").decode()
                return httpx.Response(200, json={"access_token": access, "id_token": jwt.encode(identity, signing_key, algorithm="RS256", headers={"kid": "test-key"})})
            raise AssertionError("Unexpected IAM route")
        self.sent.append(request)
        if request.url.host == "core":
            assert request.headers.get("authorization") == "Bearer server-only-test-token"
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/":
            return httpx.Response(200, text="<html><head></head><body>Knowledge</body></html>", headers={"content-type": "text/html"})
        return httpx.Response(200, content=b'event: result\ndata: done\n\n', headers={"content-type": "text/event-stream"})

    def begin(self, return_to="/"):
        response = self.client.get("/auth/login", params={"return_to": return_to}, follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        params = parse_qs(urlsplit(response.headers["location"]).query)
        self.state, self.nonce = params["state"][0], params["nonce"][0]
        self.assertEqual(params["code_challenge_method"], ["S256"])
        return response

    def signin(self):
        self.begin()
        response = self.client.get("/auth/callback", params={"state": self.state, "code": "single-code"}, follow_redirects=False)
        return response

    def test_anonymous_paths_and_host(self):
        for path in ["/v1/health", "/agent/sessions", "/web/status", "/assets/main.js", "/auth/session"]:
            self.assertEqual(self.client.get(path).status_code, 401, path)
        response = self.client.get("/", headers={"Accept": "text/html"}, follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        self.assertTrue(response.headers["location"].startswith("/auth/login"))
        self.assertEqual(self.client.get("/v1/health", headers={"Host": "attacker.test"}).status_code, 400)
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_state_cookie_replay_and_open_redirect(self):
        self.begin("//attacker.test")
        bound_cookie = self.client.cookies.get(gateway.STATE_COOKIE)
        self.client.cookies.clear()
        self.assertNotIn(gateway.COOKIE, self.client.get("/auth/callback", params={"state": self.state, "code": "c"}).cookies)
        self.client.cookies.set(gateway.STATE_COOKIE, bound_cookie, domain="kb.example.test", path="/")
        first = self.client.get("/auth/callback", params={"state": self.state, "code": "c"}, follow_redirects=False)
        self.assertEqual(first.status_code, 303)
        self.assertEqual(first.headers["location"], "/")
        self.client.cookies.clear()
        self.client.cookies.set(gateway.STATE_COOKIE, bound_cookie, domain="kb.example.test", path="/")
        replay = self.client.get("/auth/callback", params={"state": self.state, "code": "c"}, follow_redirects=False)
        self.assertNotIn(gateway.COOKIE, replay.cookies)

    def test_invalid_identities_cannot_create_session(self):
        for mode in ["wrong-org", "wrong-aud", "wrong-nonce", "expired", "forged"]:
            self.mode = mode
            self.client.cookies.clear()
            response = self.signin()
            self.assertNotIn(gateway.COOKIE, response.cookies, mode)
            self.assertEqual(self.client.get("/v1/health").status_code, 401, mode)
        self.mode = "ok"
        self.user["isForbidden"] = True
        self.assertNotIn(gateway.COOKIE, self.signin().cookies)

    def test_authorized_proxy_keeps_secrets_off_browser(self):
        response = self.signin()
        self.assertEqual(response.status_code, 303)
        session_cookie = response.headers.get("set-cookie", "")
        for attribute in ["HttpOnly", "Secure", "SameSite=lax", "Path=/"]: self.assertIn(attribute, session_cookie)
        identity = self.client.get("/auth/session")
        self.assertEqual(identity.json()["user"]["displayName"], "测试用户")
        self.assertNotIn("token", identity.text)
        self.assertEqual(self.client.get("/v1/health", headers={"Authorization": "Bearer malicious"}).status_code, 200)
        self.assertNotIn("cookie", self.sent[-1].headers)
        page = self.client.get("/")
        self.assertIn('/auth/bootstrap.js', page.text)
        self.assertNotIn(config["core_token"], page.text)
        self.assertEqual(page.headers["cache-control"], "no-store")
        js = self.client.get("/auth/bootstrap.js")
        self.assertNotIn(config["core_token"], js.text)

    def test_sidecar_payload_is_pinned_and_streamed(self):
        self.assertEqual(self.signin().status_code, 303)
        result = self.client.post("/agent/sessions/a/messages", json={"message": "hello", "coreUrl": "http://attacker.test", "token": "attacker"}, headers={"Origin": config["public_url"]})
        self.assertEqual(result.status_code, 200)
        self.assertIn("data: done", result.text)
        sent = json.loads(self.sent[-1].content)
        self.assertEqual(sent["coreUrl"], config["core_url"])
        self.assertEqual(sent["token"], config["core_token"])
        self.assertEqual(sent["message"], "hello")
        self.assertNotIn(config["core_token"], result.text)

    def test_disable_revokes_session_and_iam_failure_denies_data(self):
        self.assertEqual(self.signin().status_code, 303)
        with gateway.db() as conn: conn.execute("UPDATE sessions SET checked = 0")
        self.mode = "iam-down"
        self.assertEqual(self.client.get("/v1/health").status_code, 503)
        self.mode = "ok"
        self.user["isForbidden"] = True
        self.assertEqual(self.client.get("/v1/health").status_code, 401)
        with gateway.db() as conn: self.assertEqual(conn.execute("SELECT count(*) FROM sessions").fetchone()[0], 0)

    def test_csrf_and_logout(self):
        self.assertEqual(self.signin().status_code, 303)
        identity = self.client.get("/auth/session").json()
        self.assertEqual(self.client.post("/v1/test", headers={"Origin": "https://attacker.test"}).status_code, 403)
        self.assertEqual(self.client.post("/auth/logout", headers={"Origin": config["public_url"]}).status_code, 403)
        response = self.client.post("/auth/logout", headers={"Origin": config["public_url"], "X-KB-CSRF": identity["csrf"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(urlsplit(response.json()["redirect"]).netloc, "iam.example.test")
        self.assertEqual(self.client.get("/v1/health").status_code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
