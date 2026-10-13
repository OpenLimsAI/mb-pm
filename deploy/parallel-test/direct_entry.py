#!/usr/bin/env python3
"""IP 直连应急入口（compose.direct.yml）的 IAM 登记与核对；在服务器部署目录中运行。

    python3 direct_entry.py register        把直连入口的回调 / 登出地址加入 IAM 应用 mp-pm（幂等，先备份原列表）
    python3 direct_entry.py unregister      移除这两个地址（停用直连入口后执行）
    python3 direct_entry.py check           不用任何账号：核对健康检查、登录跳转改写、IAM 接受回调地址与跨源登录请求
    python3 direct_entry.py login <用户名>  用 ACCOUNTS.private.txt 中该账号的初始密码走一遍真实登录 / 退出（只试一次，不输出密码）

只依赖 Python 标准库。直连入口是自签名证书，本脚本访问它时不校验证书。
"""

import base64
import http.cookiejar
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIRECT = "https://36.154.190.9:8443"
DIRECT_IAM = "https://36.154.190.9:18443"
URIS = [f"{DIRECT}/api/v1/auth/callback", f"{DIRECT}/login"]
LOCAL_IAM = "http://127.0.0.1:18001"  # Casdoor 只发布在服务器回环上的端口（管理接口走这里）


def env() -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in (HERE / ".env").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )


def casdoor(method: str, path: str, params=None, body=None) -> dict:
    e = env()
    token = base64.b64encode(f"{e['CASDOOR_CLIENT_ID']}:{e['CASDOOR_CLIENT_SECRET']}".encode()).decode()
    url = f"{LOCAL_IAM}/api/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Basic {token}", "Content-Type": "application/json", "Accept-Language": "zh"},
    )
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=15) as response:
        result = json.loads(response.read())
    if result.get("status") != "ok":
        raise SystemExit(f"Casdoor {path} 失败：{result.get('msg')}")
    return result


def application() -> dict:
    app = casdoor("GET", "get-application", {"id": "admin/mp-pm"})["data"]
    if not app:
        raise SystemExit("找不到 IAM 应用 mp-pm")
    return app


def set_uris(add: bool) -> None:
    app = application()
    before = list(app.get("redirectUris") or [])
    after = [u for u in before if u not in URIS] + (URIS if add else [])
    if after == before:
        print("IAM 回调地址无需改动：", "已登记" if add else "未登记")
        return
    backups = HERE / "private-config-backups"
    backups.mkdir(exist_ok=True)
    backup = backups / f"mp-pm-redirectUris.{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
    backup.write_text(json.dumps(before, indent=2))
    backup.chmod(0o600)
    app["redirectUris"] = after
    # 只更新这一列；get-application 返回的 clientSecret 若为 *** 会被 Casdoor 忽略
    casdoor("POST", "update-application", {"id": "admin/mp-pm", "columns": "redirectUris"}, app)
    if application().get("redirectUris") != after:
        raise SystemExit("回调地址未按预期更新，请检查 IAM 应用配置")
    print(f"IAM 回调地址 {len(before)} → {len(after)} 条（原列表备份：{backup.name}）")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def client():
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # 自签名证书
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context),
        urllib.request.HTTPCookieProcessor(jar),
        NoRedirect(),
    )

    def call(url, data=None, headers=None, method=None):
        request = urllib.request.Request(
            url,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json", **(headers or {})},
            method=method,
        )
        try:
            response = opener.open(request, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        return response.code, response.headers, response.read()

    return call


def begin_login(call) -> dict:
    status, headers, _ = call(f"{DIRECT}/api/v1/auth/login?return_to=/projects")
    location = headers.get("Location", "")
    assert status == 303 and location.startswith(f"{DIRECT_IAM}/login/oauth/authorize?"), (status, location[:80])
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(location).query))
    assert query["redirect_uri"] == URIS[0], query["redirect_uri"]
    return query


def oauth_params(query: dict) -> dict:
    return {
        "clientId": query["client_id"],
        "responseType": "code",
        "redirectUri": query["redirect_uri"],
        "type": "code",
        "scope": query["scope"],
        "state": query["state"],
        "nonce": query["nonce"],
        "code_challenge_method": query["code_challenge_method"],
        "code_challenge": query["code_challenge"],
    }


def check() -> None:
    call = client()
    status, _, body = call(f"{DIRECT}/health")
    assert status == 200, f"health {status}"
    print("应用健康检查：200")
    status, _, body = call(f"{DIRECT}/api/v1/auth/config")
    assert json.loads(body)["login_url"] == f"{DIRECT}/api/v1/auth/login", body[:120]
    print("登录入口：", f"{DIRECT}/api/v1/auth/login")
    query = begin_login(call)
    print("登录跳转已改写到直连 IAM：", f"{DIRECT_IAM}/login/oauth/authorize（回调 {query['redirect_uri']}）")
    params = oauth_params(query)
    status, _, body = call(f"{DIRECT_IAM}/api/get-app-login?" + urllib.parse.urlencode(params))
    result = json.loads(body)
    assert result.get("status") == "ok", f"IAM 拒绝回调地址：{result.get('msg')}"
    print("IAM 接受直连回调地址：ok")
    status, _, body = call(f"{DIRECT_IAM}/login/oauth/authorize?" + urllib.parse.urlencode(query))
    assert status == 200 and b"<html" in body.lower(), status
    print("IAM 登录页：200")
    # 不存在的用户名：只验证跨源登录请求被 IAM 放行（403 表示被 CORS 拦截），不碰任何真实账号
    status, _, body = call(
        f"{DIRECT_IAM}/api/login?" + urllib.parse.urlencode(params),
        data={"application": "mp-pm", "organization": "mabpharm", "username": "zz-direct-entry-probe",
              "password": "x", "autoSignin": True, "type": "code", "signinMethod": "Password"},
        headers={"Origin": DIRECT_IAM},
    )
    result = json.loads(body) if body else {}
    assert status == 200 and result.get("status") == "error", (status, result)
    print("跨源登录请求被放行（探测账号不存在，返回：", (result.get("msg") or "")[:40], "）")


def login(username: str) -> None:
    accounts = {}
    for line in (HERE / "ACCOUNTS.private.txt").read_text().splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and not line.startswith("#"):
            accounts[parts[0]] = parts[2]
    if username not in accounts:
        raise SystemExit(f"ACCOUNTS.private.txt 中没有 {username}")
    call = client()
    query = begin_login(call)
    status, _, body = call(
        f"{DIRECT_IAM}/api/login?" + urllib.parse.urlencode(oauth_params(query)),
        data={"application": "mp-pm", "organization": "mabpharm", "username": username,
              "password": accounts[username], "autoSignin": True, "type": "code", "signinMethod": "Password"},
        headers={"Origin": DIRECT_IAM},
    )
    result = json.loads(body)
    if result.get("status") != "ok":
        raise SystemExit(f"IAM 登录未通过（可能已改过密码），未重试：{(result.get('msg') or '')[:60]}")
    status, headers, _ = call(f"{DIRECT}/api/v1/auth/callback?" + urllib.parse.urlencode({"code": result["data"], "state": query["state"]}))
    assert status == 303 and headers.get("Location") == f"{DIRECT}/projects", (status, headers.get("Location"))
    status, _, body = call(f"{DIRECT}/api/v1/auth/me")
    me = json.loads(body)
    assert status == 200 and me["username"] == username, (status, body[:80])
    status, _, body = call(f"{DIRECT}/api/v1/projects?page_size=200")
    projects = json.loads(body)
    print(f"登录成功：{me['username']}（{me['role']}），可见项目 {projects['meta']['total']} 个")
    status, headers, _ = call(f"{DIRECT}/api/v1/auth/logout", data={}, headers={"Origin": DIRECT}, method="POST")
    assert status == 303 and headers.get("Location", "").startswith(f"{DIRECT_IAM}/api/logout?"), (status, headers.get("Location", "")[:60])
    status, _, _ = call(f"{DIRECT}/api/v1/auth/me")
    assert status == 401, status
    print("退出成功，会话已失效")


if __name__ == "__main__":
    if sys.argv[1:] == ["register"]:
        set_uris(True)
    elif sys.argv[1:] == ["unregister"]:
        set_uris(False)
    elif sys.argv[1:] == ["check"]:
        check()
    elif len(sys.argv) == 3 and sys.argv[1] == "login":
        login(sys.argv[2])
    else:
        raise SystemExit(__doc__)
