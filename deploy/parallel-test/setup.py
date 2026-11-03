#!/usr/bin/env python3
"""新版并行测试栈的一次性初始化；在客户服务器的部署目录（与 compose.yml 同目录）中运行。

    python3 setup.py init <镜像标签>   生成 .env / app.conf / init_data.json / ACCOUNTS.private.txt（均 600）；
                                       已存在 .env 则直接退出，绝不重置已有凭据
    python3 setup.py secure-iam        Casdoor 首次启动后运行：把它自动创建的控制台管理员 built-in/admin
                                       的默认密码 123 改为随机密码，并核对组织 / 应用 / 角色 / 账号

只读访问现网：从 dikw-postgres 的 mb_pm 读取要开通 IAM 的管理员账号的姓名与邮箱，不写现网任何数据。
只依赖 Python 标准库（服务器系统自带 python3 即可）。
"""

import base64
import json
import secrets
import string
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORG, APP = "mabpharm", "mp-pm"
# 测试经 SSH 隧道访问（用 127.0.0.1，避免与本机开发环境 localhost 的 cookie 互相覆盖）
PMS_PUBLIC_URL = "http://127.0.0.1:18082"
CASDOOR_ENDPOINT = "http://127.0.0.1:18001"
# 本次只为这两个现网管理员开通 IAM 账号；其余成员之后由 IAM 管理员按原用户名建号
ADMINS = {"020104": "admin", "guo.cmc": "cmc_lead"}
ROLES = [
    ("admin", "系统管理员"),
    ("cmc_lead", "CMC 负责人"),
    ("project_lead", "项目负责人"),
    ("rd", "工艺开发"),
    ("production", "生产支持"),
    ("qa_qc", "QA/QC"),
]
LIVE_ENV = Path("/home/prometheus/mb-pm/.env")  # 现网部署的数据库口令（只读）

APP_CONF = """appname = casdoor
httpport = 8000
runmode = prod
copyrequestbody = true
driverName = postgres
dataSourceName = "user=casdoor password={password} host=iam-db port=5432 sslmode=disable dbname=casdoor"
dbName = casdoor
tableNamePrefix =
showSql = false
redisEndpoint =
defaultStorageProvider =
isCloudIntranet = false
authState = "casdoor"
verificationCodeTimeout = 10
initScore = 0
logPostOnly = true
isUsernameLowered = false
origin = "{origin}"
originFrontend =
staticBaseUrl = "https://cdn.casbin.org"
isDemoMode = false
batchSize = 100
showGithubCorner = false
forceLanguage = "zh"
defaultLanguage = "zh"
defaultApplication = "app-built-in"
maxItemsForFlatMenu = 7
enableErrorMask = true
enableGzip = true
ldapServerPort = 389
radiusServerPort = 1812
radiusDefaultOrganization = "built-in"
radiusSecret = "{radius}"
quota = {{"organization": -1, "user": -1, "application": -1, "provider": -1}}
logConfig = {{"adapter":"file", "filename": "logs/casdoor.log", "maxdays":14, "maxsize":10485760, "daily":true, "rotate":true, "perm":"0770"}}
initDataNewOnly = true
initDataFile = "/init_data.json"
"""


def password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        value = "".join(secrets.choice(alphabet) for _ in range(length))
        if any(c.isdigit() for c in value) and any(c.isalpha() for c in value):
            return value


def write(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o600)


def read_env(path: Path) -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in path.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )


def live_admins() -> dict[str, tuple[str, str]]:
    names = ",".join(f"'{n}'" for n in ADMINS)
    sql = (
        "select username, display_name, email from users "
        f"where username in ({names}) and is_active"
    )
    result = subprocess.run(
        # 口令经 stdin 传入容器，不出现在进程参数里
        [
            "docker",
            "exec",
            "-i",
            "dikw-postgres",
            "sh",
            "-c",
            'PGPASSWORD="$(cat)" psql -h 127.0.0.1 -U mbpm -d mb_pm -tA -F "|" -c "$0"',
            sql,
        ],
        input=read_env(LIVE_ENV)["PW_DB"],
        check=True,
        capture_output=True,
        text=True,
    )
    rows = {}
    for line in result.stdout.splitlines():
        if line.strip():
            username, display_name, email = line.split("|")
            rows[username] = (display_name, email)
    missing = sorted(set(ADMINS) - set(rows))
    if missing:
        raise SystemExit(f"现网没有这些启用的账号：{missing}")
    return rows


def init(tag: str) -> None:
    if (HERE / ".env").exists():
        raise SystemExit("已初始化（.env 已存在），没有改动任何凭据。")
    admins = live_admins()
    creds = {
        k: secrets.token_urlsafe(32) for k in ("PMS_DB_PASSWORD", "IAM_DB_PASSWORD")
    }
    creds["APP_SECRET"] = secrets.token_urlsafe(48)
    creds["CASDOOR_CLIENT_SECRET"] = secrets.token_urlsafe(32)
    client_id = "mbpm-" + secrets.token_hex(6)
    env = {
        "PMS_IMAGE_TAG": tag,
        **creds,
        "CASDOOR_CLIENT_ID": client_id,
        "PMS_PUBLIC_URL": PMS_PUBLIC_URL,
        "CASDOOR_ENDPOINT": CASDOOR_ENDPOINT,
    }
    write(HERE / ".env", "".join(f"{k}={v}\n" for k, v in env.items()))
    write(
        HERE / "app.conf",
        APP_CONF.format(
            password=creds["IAM_DB_PASSWORD"],
            origin=CASDOOR_ENDPOINT,
            radius=secrets.token_urlsafe(24),
        ),
    )
    accounts = {name: password() for name in ADMINS}
    seed = {
        "organizations": [
            {
                "owner": "admin",
                "name": ORG,
                "displayName": "迈博药业",
                "websiteUrl": "https://www.mabpharm.com",
                "favicon": f"{CASDOOR_ENDPOINT}/files/favicon.png",
                "passwordType": "bcrypt",
                "passwordOptions": ["AtLeast6"],
                "countryCodes": ["CN"],
                "defaultAvatar": f"{CASDOOR_ENDPOINT}/files/maibo-logo.png",
                "languages": ["zh"],
                "tags": [],
                "masterPassword": "",
                "defaultPassword": "",
                "enableSoftDeletion": False,
                "isProfilePublic": False,
                "themeData": {
                    "themeType": "default",
                    "colorPrimary": "#1a4f9c",
                    "borderRadius": 6,
                    "isCompact": False,
                },
            }
        ],
        "applications": [
            {
                "owner": "admin",
                "name": APP,
                "displayName": "CMC 项目管理系统",
                "logo": f"{CASDOOR_ENDPOINT}/files/maibo-logo.png",
                "homepageUrl": PMS_PUBLIC_URL,
                "organization": ORG,
                "cert": "cert-built-in",
                "enablePassword": True,
                "enableSignUp": False,  # 账号由 IAM 管理员统一开通，不开放自助注册
                "clientId": client_id,
                "clientSecret": creds["CASDOOR_CLIENT_SECRET"],
                "enablePkce": True,
                "grantTypes": ["authorization_code", "refresh_token"],
                "redirectUris": [
                    f"{PMS_PUBLIC_URL}/api/v1/auth/callback",
                    f"{PMS_PUBLIC_URL}/login",
                ],
                "tokenFormat": "JWT",
                "tokenFields": [],
                "expireInHours": 1,
                "signinMethods": [
                    {"name": "Password", "displayName": "Password", "rule": "All"}
                ],
            }
        ],
        "roles": [
            {
                "owner": ORG,
                "name": role,
                "displayName": label,
                "users": [f"{ORG}/{u}" for u, r in ADMINS.items() if r == role],
                "roles": [],
                "isEnabled": True,
            }
            for role, label in ROLES
        ],
        "users": [
            {
                "owner": ORG,
                "name": name,
                "type": "normal-user",
                "password": accounts[name],
                "displayName": admins[name][0],
                "email": admins[name][1],
                "isAdmin": False,  # 业务管理员不是 IAM 控制台管理员
                "signupApplication": APP,
            }
            for name in ADMINS
        ],
    }
    write(HERE / "init_data.json", json.dumps(seed, ensure_ascii=False, indent=2))
    lines = [
        "# 新版并行测试栈的初始账号（仅本文件保存，权限 600；分发后请提醒首次登录修改密码）",
        f"# 项目管理：{PMS_PUBLIC_URL}   IAM：{CASDOOR_ENDPOINT}（均需 SSH 隧道）",
        *(f"{name}\t{ADMINS[name]}\t{accounts[name]}" for name in ADMINS),
        f"built-in/admin\tIAM 控制台管理员\t{password(20)}",
    ]
    write(HERE / "ACCOUNTS.private.txt", "\n".join(lines) + "\n")
    print("已生成 .env / app.conf / init_data.json / ACCOUNTS.private.txt（600）。")


def casdoor(method: str, path: str, *, params=None, form=None, body=None) -> dict:
    env = read_env(HERE / ".env")
    token = base64.b64encode(
        f"{env['CASDOOR_CLIENT_ID']}:{env['CASDOOR_CLIENT_SECRET']}".encode()
    ).decode()
    url = f"{CASDOOR_ENDPOINT}/api/{path}" + (
        "?" + urllib.parse.urlencode(params) if params else ""
    )
    headers = {"Authorization": f"Basic {token}", "Accept-Language": "zh"}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=15) as response:
        body = json.loads(response.read())
    if body.get("status") != "ok":
        raise SystemExit(f"Casdoor {path} 失败：{body.get('msg')}")
    return body


def secure_iam() -> None:
    console = next(
        line.split("\t")[2]
        for line in (HERE / "ACCOUNTS.private.txt").read_text().splitlines()
        if line.startswith("built-in/admin\t")
    )
    try:
        casdoor("POST", "check-user-password",
                body={"owner": "built-in", "name": "admin", "password": console})
    except SystemExit:
        casdoor(
            "POST", "set-password",
            form={"userOwner": "built-in", "userName": "admin",
                  "oldPassword": "", "newPassword": console},
        )
    # 用新口令核对一次（成功会清零失败计数；不拿旧口令试探，免得计入失败次数）
    casdoor(
        "POST",
        "check-user-password",
        body={"owner": "built-in", "name": "admin", "password": console},
    )
    org = casdoor("GET", "get-organization", params={"id": f"admin/{ORG}"})["data"]
    app = casdoor("GET", "get-application", params={"id": f"admin/{APP}"})["data"]
    roles = {
        r: casdoor("GET", "get-role", params={"id": f"{ORG}/{r}"})["data"]["users"]
        for r, _ in ROLES
    }
    users = [
        casdoor("GET", "get-user", params={"id": f"{ORG}/{u}"})["data"] for u in ADMINS
    ]
    assert org and org["name"] == ORG, "组织缺失"
    # Casdoor 3.100.0 does not return an enablePkce application field.
    # Validate the configured grant here; the OAuth smoke test checks PKCE.
    assert (
        app and app["enableSignUp"] is False
        and "authorization_code" in app["grantTypes"]
    ), "应用配置异常"
    assert all(
        u and u["name"] in ADMINS and not u["isAdmin"] for u in users
    ), "账号缺失"
    print("IAM 控制台管理员默认密码已替换；组织 / 应用 / 角色 / 账号核对通过：")
    print({role: members for role, members in roles.items() if members})


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "init":
        init(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] == "secure-iam":
        secure_iam()
    else:
        raise SystemExit(__doc__)
