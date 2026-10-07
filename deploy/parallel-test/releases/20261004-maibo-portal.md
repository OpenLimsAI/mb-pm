# 迈博药业员工门户上线记录

日期：2026-10-04（Asia/Taipei）。门户已部署；真实用户登录、工作台及跨应用 SSO 验收待完成。2026-10-08 补记：跨应用 SSO 已开启，测试账号验收通过，见下文「补记：跨应用 SSO」。

## 发布内容

- 主入口：[www.openlims.ai](https://www.openlims.ai)。新增迈博品牌登录、应用工作台、我的账号、使用帮助，共 4 个用户页面；另有 `/launch/pm`、`/launch/kb` 两个受权限控制的固定应用入口。
- PM 保留 [pm.openlims.ai](https://pm.openlims.ai)，KB 保留 [kb.openlims.ai](https://kb.openlims.ai)，统一身份服务为 [iam.openlims.ai](https://iam.openlims.ai)。门户只展示身份与应用准入，应用自行验证数据权限，不自动赋权。
- 发布完整前后端，仅重建 `mb-pm-v2-app-1`。数据库、AI 持久卷和原 `APP_SECRET` 保留；启动新增 `portal_logins`、`portal_sessions` 表。

| 项目 | 实际值 |
|---|---|
| 新镜像 | `mb-pm:portal-20261003T194612Z` |
| 镜像 ID | `sha256:535ad30e8204bbb22763eb0c94396fb986652f43456e664c90a4ad266dc2044d` |
| 回滚镜像 | `mb-pm:knowledge-link-20261003T090717Z` |
| Git 基线 | `f44a0b058900d39346ffeca2c1d9ad349019977d`，包含未提交修改，不能仅凭基线复现 |
| 准确构建输入 | `/home/prometheus/mb-pm-v2/releases/portal-20261003T194612Z/`，204 个输入文件，各文件 SHA256 见 `source-state.json` |
| 备份 | `/home/prometheus/mb-pm-v2/private-config-backups/portal-20261003T194612Z/` |

备份含 `pms.dump`、`iam.dump`（已验证可读取归档目录）、原 `.env`、两份 Compose、`app.conf`、前一镜像信息及 IAM 应用配置；私密配置只保存在服务器受保护目录。源包不包含运行密钥、数据库或整个部署目录。

## 入口和身份配置

- Cloudflare `Maibo-pm` 隧道新增 `www.openlims.ai → HTTP app:8000`，Path 留空。www CNAME 从 `parkingpage.namecheap.com` 改为 `9fd0232f-e065-4925-8c17-98e73f2ba463.cfargotunnel.com`，代理开启、TTL 自动。原 PM / IAM / KB 路由及域名根记录保留。最初的 www 525 错误在纠正 DNS 后消失，未降低 SSL 安全设置。
- 新独立 Casdoor 应用 `admin/maibo-portal`，组织 `mabpharm`，公开 Client ID `portal-fd6e73ef7b442ff3`。关闭自助注册；JWT 全字段、证书 `cert-built-in`；使用授权码及 PKCE S256。
- 精确回调 `https://www.openlims.ai/api/v1/portal/callback`，退出回跳 `https://www.openlims.ai/login`。服务器新增 `PORTAL_PUBLIC_URL`、`PORTAL_CLIENT_ID`、`PORTAL_CLIENT_SECRET`、`PORTAL_JWKS_URL`；最后一项为空时使用原 IAM 公钥端点。CORS 仅列出 www / pm。
- 门户与 PM 独立客户端及 Host-only Cookie；导航 URL 不传令牌。退出门户结束门户会话并请求 IAM 退出，已有 PM / KB 会话在各应用分别退出。
- KB 现用原生网页 v0.11.0，公开地址 `https://kb.openlims.ai`；独立 IAM 客户端 `dikw-4b017ecb75a7ae01`，回调 `https://kb.openlims.ai/web/auth/callback`。本次未重建知识库服务。

## 已验证和剩余验收

- 本地完整后端 149 项测试（含门户 / IAM 80 项）、TypeScript / Vite 构建、变更文件 ESLint、路由安全检查通过。
- 使用最新 PM 数据副本的候选容器通过 15 项检查，覆盖页面、独立客户端/回调、S256、Cookie、匿名拦截、错误 Origin、保留 PM 登录和禁用注册。该容器 `mbpm-portal-verify` 及副本库 `portal_verify_20261003t194612z` 已清理，保留生产数据与备份。
- 公网及服务状态 14 项检查通过：门户登录/帮助/账号页面外壳、配置及健康返回 200；门户和 PM 匿名业务接口返回 401；门户授权请求使用新客户端和 www 回调。匿名 KB 命令行请求返回 401，浏览器正常显示独立知识库 IAM 登录，不能据此视为业务登录已成功。
- 浏览器视觉确认迈博品牌登录页，核对门户和 KB 的 IAM 页面、独立客户端、精确回调和 S256。`app`、项目库、IAM 库、KB web/core/database 健康，Casdoor、Tunnel、Caddy 保持运行。
- **待完成：** 客户业务账号真实授权码换取令牌、回到 www 工作台、身份/准入/账号页、PM 和 KB 的单点登录及实际内容、KB-only 账号限制、手机登录后布局、退出及权限不足提示。当前没有浏览器 IAM 会话，未读取服务器账号密码文件，也未更改用户密码。

服务器机器记录：上述源码目录中的 `candidate-validation.json`、`deployment-summary.json`、`public-validation.json`。代码未因本次部署自动提交 GitHub。

### 补记：跨应用 SSO（2026-10-08，Asia/Taipei）

- 问题：在 www、PM、KB 中每打开一个应用，都要再输一次密码。
- 原因：IAM 的 4 个应用都没开 `enableSigninSession`。Casdoor 3.100 在这种情况下，授权码登录后不保留 IAM 会话。
- 改动（07:25，只改 IAM，没有重建 `app`）：`maibo-portal`、`mp-pm`、`dikw-kb`、`dikw-web` 都打开 `enableSigninSession`、`enableAutoSignin`，`cookieExpireInHours` 设为 168。改前快照在服务器 `private-config-backups/20261007T232541Z-sso-session/`。原因、影响和约束见 OpenLimsAI/mb-casd#12（ADR-0004）。
- 验收（Chrome，测试账号 `hele.hl`，PM `admin` + `kb_editor`）：
  1. 在 KB 输一次密码。
  2. 打开 www，点「使用迈博账号登录」，直接进入工作台，PM、KB 两张卡片都可用。
  3. 打开 IAM 控制台，直接进入应用列表。
  4. 打开 `https://pm.openlims.ai/api/v1/auth/login`，重新授权后直接进入 PM。
- Casdoor 为 `maibo-portal`、`mp-pm` 签发了新 token，说明是完整的授权流程。
- 仍待完成：客户业务账号、账号页、权限不足提示、`/launch/*` 跳转、KB-only 账号限制、手机布局、退出检查。

## 后续发版与回滚

修改后先更新 `docs/releases/notes.json`，构建完整镜像；使用服务器已有密钥和两份 Compose，仅 `up -d --no-deps app`。后端或表结构变更前重新备份数据库，不使用旧快照覆盖客户数据。

应用异常时，将服务器 `.env` 的 `PMS_IMAGE_TAG` 改回 `knowledge-link-20261003T090717Z`，在 `/home/prometheus/mb-pm-v2` 执行：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
curl -fsS http://127.0.0.1:18082/health
```

不整份恢复 `.env`，不回退数据库或删除门户表。旧镜像不提供门户；若仅撤销 www 入口，可停用新增 www 隧道路由并恢复原 www CNAME，PM / IAM / KB 无需改动。保留新增 IAM 应用和配置供修复，避免正在使用时误删。
