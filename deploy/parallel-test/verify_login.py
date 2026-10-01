#!/usr/bin/env python3
"""Exercise the actual OAuth/PKCE callback and authenticated API without logging secrets."""
import http.cookiejar
import json
import urllib.parse
import urllib.request
from pathlib import Path
import setup

HERE = Path(__file__).resolve().parent
CONFIG = setup.read_env(HERE / ".env")
PMS = CONFIG["PMS_PUBLIC_URL"].rstrip("/")
IAM = CONFIG["CASDOOR_ENDPOINT"].rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    credentials = [l.split("\t") for l in (HERE / "ACCOUNTS.private.txt").read_text().splitlines()
                   if l and not l.startswith("#") and not l.startswith("built-in/")]
    results = []
    for username, role, password in credentials:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                    urllib.request.HTTPCookieProcessor(jar), NoRedirect())

        def request(url, data=None, headers=None):
            req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                    headers={"Content-Type": "application/json", **(headers or {})})
            try:
                response = opener.open(req, timeout=20)
            except urllib.error.HTTPError as exc:
                response = exc
            return response.code, response.headers, response.read()

        status, headers, _ = request(PMS + "/api/v1/auth/me")
        assert status == 401, f"Unauthenticated me: {status}"
        status, headers, _ = request(PMS + "/api/v1/auth/login")
        assert status == 303, f"Start login: {status}"
        params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(headers["Location"]).query))
        assert params["code_challenge_method"] == "S256"
        mapping = {"client_id":"clientId", "response_type":"responseType", "redirect_uri":"redirectUri",
                   "code_challenge":"codeChallenge", "code_challenge_method":"codeChallengeMethod"}
        query = {mapping.get(k,k):v for k,v in params.items()}
        status, _, body = request(IAM + "/api/login?" + urllib.parse.urlencode(query),
            {"application":"mp-pm", "organization":"mabpharm", "username":username,
             "password":password, "autoSignin":False, "type":"code"})
        result = json.loads(body)
        assert result.get("status") == "ok", f"IAM login rejected: {result.get('msg')}"
        code = result.get("data")
        assert isinstance(code, str) and code, "Missing authorization code"
        status, headers, _ = request(PMS + "/api/v1/auth/callback?" + urllib.parse.urlencode({"code":code,"state":params["state"]}))
        assert status == 303 and "error=" not in headers.get("Location", ""), "OAuth callback failed"
        status, _, body = request(PMS + "/api/v1/auth/me")
        assert status == 200, f"Authenticated me: {status}"
        user = json.loads(body)
        assert user["username"] == username and user["role"] == role
        status, _, body = request(PMS + "/api/v1/projects")
        assert status == 200, f"Projects API: {status}"
        projects = json.loads(body)
        results.append({"username":username, "role":role, "login":"passed", "projects_response_type":type(projects).__name__})
        status, _, _ = request(PMS + "/api/v1/auth/logout", {}, {"Origin":PMS})
        assert status in (200,303), f"Logout: {status}"
        status, _, _ = request(PMS + "/api/v1/auth/me")
        assert status == 401, "Logout did not invalidate session"
    (HERE / "verification.json").write_text(json.dumps(results, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
