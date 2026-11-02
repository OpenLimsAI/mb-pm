# 主数据管理迁至门户同域路径 · 运维记录（2026-11-02）

**状态：已完成生产配置切换，真实账号业务验收待完成。** 2026-11-02 10:24:06（America/New_York，UTC-5；服务器回执 `2026-11-02T15:24:06.845476+00:00`）将 MDM 基址改为 `https://www.openlims.ai/mdm/`。本次调整应用地址、反向代理与 IAM 回调，不迁移业务数据库。

## 固定版本与范围

| 应用 | 固定源码 | 沿用镜像 ID |
| --- | --- | --- |
| PM / 门户 | `1b2cbe5270f3d8b0d1b9759dac63d43639ace94b` | `sha256:ce175a32c80898886a44d790839b26babb75a35d49e5746357f2686c4cee2383` |
| MDM backend | `908ed65b050de10a106c8d5ed6ff26cf8b845bfd` | `sha256:70136f05ed8beff69ebbcec21693198df956399447a54922debb294fffc121d4` |
| MDM web | 同上 | `sha256:ea1f7bac8a2000d00e3a9491c8f21e42dbcffa4b2a941c9cb2c18b8cd44566f7` |

PM 镜像标签仍为 `mb-pm:login-build-fix-1b2cbe5-20261102`。本轮仅按新配置重建 `cmab-mdm-maibo-backend-1`、`cmab-mdm-maibo-web-1`、`mb-pm-v2-app-1`、`mb-pm-v2-app-direct-1`；镜像不变，另外 13 个生产容器的 ID 与镜像不变。没有前端重编译、数据库迁移、账号密码或角色调整。

门户仍由受保护的 `/launch/mdm` 核对准入，再打开 `https://www.openlims.ai/mdm/projects`。MDM 前端、API 和 React Router 原本已使用 `/mdm/`；采用保留此前缀的实际路径代理，MDM 页面地址保留在 www 主机。

## Cloudflare 路由与配置

`Maibo-pm` 隧道实际收到的新顺序已由连接器配置日志核验。以下两条按此顺序匹配：

| 顺序 | 主机 | 路径 | 服务 |
| --- | --- | --- | --- |
| 在前 | `www.openlims.ai` | `^/mdm(/.*)?$` | `http://mdm-web:80` |
| 在后 | `www.openlims.ai` | 空 | `http://app:8000` |

Cloudflare [采用从上到下的首个匹配规则](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/#test-ingress-rules)；空路径规则会匹配该主机所有路径，若置于前面会把 MDM 请求交给门户。其他域名规则和 www DNS 保留，路径分流不需要新增 DNS。MDM nginx 将 `/mdm/api/` 转发至后端 `/api/`；保留 `/mdm` 前缀，不让门户 SPA 接管 MDM 路由。

MDM nginx 的只读配置挂载还负责 `/mdm` 到 HTTPS `/mdm/` 的 308 归一化，以及旧 `mdm.openlims.ai` 请求到 `https://www.openlims.ai$request_uri` 的 307 临时跳转。旧域保留原路径和查询，验收阶段不使用永久跳转，避免缓存妨碍回退。

| 位置 | 已应用配置 |
| --- | --- |
| PM 两实例 | `MDM_PUBLIC_URL=https://www.openlims.ai/mdm/` |
| MDM 后端 | `MDM_PUBLIC_URL=https://www.openlims.ai/mdm`；`CORS_ORIGINS=https://www.openlims.ai` |
| IAM `maibo-mdm` | `homepageUrl=https://www.openlims.ai/mdm/`；回调 `https://www.openlims.ai/mdm/api/v1/auth/oidc/callback` |
| IAM `maibo-mdm-pm-delegation` | 同上首页；回调 `https://www.openlims.ai/mdm/api/v1/auth/oidc/pm-callback` |

两个 IAM 客户端还将登出回跳更新为 `https://www.openlims.ai/mdm/login?reason=logout`。更新前备份完整对象，更新后核对 `clientId`、`clientSecret`、组织、授权类型及内网 `backchannelLogoutUri` 保持原值；后者仍为 `http://mdm-backend:8000/api/v1/auth/oidc/backchannel-logout`，不因公开主机变化改成公网地址。

MDM Cookie 为 host-only、`Path=/mdm/`、Secure、HttpOnly，名称与门户 / PM 会话不同；旧子域名 Cookie 不会成为新主机会话，迁移后须正常登录。应用仍独立核验身份、临时密码策略和业务权限，同域不授予额外角色。

PM 保留实际七份 Compose 组合，见[登录恢复记录](20261102-login-build-fix.md#备份候选与切换)。展开配置的差异限定为本轮公开 URL。MDM 保留原数据库、Redis、专用网络及镜像，只增加 nginx 配置挂载并删除曾声明但切换前实际未发布的 `127.0.0.1:18091` 映射，维持没有 MDM 宿主直连端口的运行状态。

## 备份与回执

服务器任务目录：`/home/prometheus/cmab-mdm-maibo/www-mdm-20261102/`，受限备份在 `before/`，候选在 `candidate/`。真实环境、客户端完整对象和数据库 dump 均留在服务器，不提交 Git。

- `before/` 包含 PM / MDM 运行配置、实际七份 PM Compose、展开配置、容器与镜像基线、原 nginx 配置、两个 IAM 客户端完整对象。
- 三库自定义格式 dump：`mdm.dump` 245083 B、`iam.dump` 1075709 B、`pm.dump` 2270499 B，均通过 `pg_restore --list` 目录可读校验；本次没有把这些备份实际恢复到生产库。
- `prepared.json`：候选公开地址、两种回调、Cookie 路径、nginx `-t` 结果。
- `manifest.private.json`：切换前配置摘要、候选摘要、容器基线及实际 Compose 命令；含私密配置定位，仅限运维读取。
- `verification.json`：完成时间、固定源码、路由顺序、应用健康、匿名鉴权、IAM 公开 URI 及未变容器数量。
- 运维脚本：`/home/prometheus/cmab-mdm-maibo/migrate-www-20261102.py`；切换前校验路由顺序、无近期未结束助手请求、所有配置及 IAM 对象仍等于备份、运行容器仍等于基线，再依次更新并等待健康。异常触发服务器及 IAM 配置回退，Cloudflare 需人工配合。

旧目录 `www-path-20261101T121122Z` 仅为早期候选；本次以 `www-mdm-20261102` 回执为准，不使用旧候选中的 PM 镜像覆盖当前登录修复。

## 验证与限制

- MDM 后端配置的公开地址、两种 callback、Secure Cookie 和 CORS 均为新值；健康接口 200，匿名项目接口 401。
- PM 两实例健康接口 200，匿名门户身份接口 401，`mdm_url()` 均返回 `https://www.openlims.ai/mdm/projects`。
- MDM nginx 页面和静态资源的源站检查 200，匿名业务 API 401，旧主机 307 指向新 HTTPS 主机。
- 2026-11-02 10:26:53（America/New_York），使用正常 TLS 证书验证的独立公网探测通过：`/mdm` 返回 308 到 `https://www.openlims.ai/mdm/`；`/mdm/`、`/mdm/projects` 返回 200 HTML；`index-Dr5G9YE7.js` 返回 200 / `application/javascript`，`index-DOuScYsg.css` 返回 200 / `text/css`。
- 公网 `/mdm/api/v1/health=200`，匿名 `/mdm/api/v1/projects=401`；OIDC 配置为启用、原生登录关闭。旧子域项目路径 307 到新主机同路径，门户 `/login` 与 `/assistant` 继续返回 200 HTML。
- 2026-11-02 10:27:16（America/New_York），最终源站核对：登录起始请求 303 到 HTTPS IAM，`client_id=maibo-mdm`、`redirect_uri=https://www.openlims.ai/mdm/api/v1/auth/oidc/callback`，含 PKCE S256、state、nonce；登录 Cookie 为 Secure / HttpOnly / SameSite=Lax / Path=/mdm/。缺少 state / code 的回调安全返回新主机 `/mdm/login?oidc_error=state`；匿名会话与 PM 委托登录接口均为 401。该检查不输入真实账号凭据。
- 源站初验发现 nginx 相对斜线跳转会依据隧道内 HTTP 生成 `http://` 绝对地址，随后改为显式 HTTPS 并保留查询参数；`nginx -t` 与 reload 通过，上述公网 308 检查为修正后结果。

此前真实浏览器已在旧主机完成 IAM 跳转，但 MDM 会话接口返回 `40308 temporary_password_expired`（临时密码已过期）。本轮不重置密码、不修改用户或绕过策略；该账号的重新发放 / 本人首次改密须单独处理。尚未以客户账号完成新主机登录、委托创建、统一退出或项目写入，不将这些算作已验收。本文档补充走独立 PR 和全部 CI，纯文档合并不再次部署应用。

## 回退步骤与边界

以下命令仅供确需回退本次入口配置时由运维执行，使用现有服务器权限。先保留故障诊断和当前配置副本，并核对没有后续发布覆盖本轮目标文件；脚本是本次切换的回退材料，不能未经比较用于撤销以后版本。

1. 保留旧 `mdm.openlims.ai → http://mdm-web:80` 路由，在服务器执行：

   ```sh
   python3 /home/prometheus/cmab-mdm-maibo/migrate-www-20261102.py rollback
   ```

   脚本恢复 `before/` 的 MDM runtime、MDM Compose、PM production / direct Compose、原 nginx，以及两个 IAM 客户端的首页和回调字段；保持当前其他 IAM 字段。按备份中的完整 Compose 命令重建上述四个服务，等待 backend / app / app-direct 健康并强制重建 web，写入 `rollback.json`。保留 MDM 无宿主直连端口状态，沿用原固定镜像。
2. 在 Cloudflare 移除本次 `www.openlims.ai` 的 `^/mdm(/.*)?$` 路由，保留 www 默认门户和旧 MDM 子域规则。脚本不会自动修改 Cloudflare；只恢复服务器而保留新路径规则不算完整回退。
3. 确认 PM 的 MDM 基址、两客户端回调与旧域一致，旧域页面 / 资源正常、匿名 API 仍拒绝，www 门户和其他应用入口正常；再用合规的有效账号做登录验收。

回退不恢复数据库、不删除卷、不更换密钥和密码，不撤销上线后业务写入。遇到配置漂移先重做比较，禁止整体覆盖 IAM 当前对象或使用旧源码 / 镜像代替本次快照。
