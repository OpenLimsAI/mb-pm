# 配置与权限

[返回 README](../README.md) · [本地开发](development.md) · [功能说明](features.md)

## 配置入口

- 前端：以 [`.env.local.example`](../.env.local.example) 为参考，在 `.env.local` 设置 API 开关及开发代理目标。
- 后端：以 [`backend/.env.example`](../backend/.env.example) 为参考，在 `backend/.env` 配置数据库、IAM 和会话密钥。
- 生产：沿用服务器已有受保护配置，具体变量及环境状态见 [部署交接简明](部署交接简明.md)。密码、私钥、客户端密钥与数据库不写入文档或仓库。

`backend/.env.example` 示例使用 PostgreSQL；本地使用 SQLite 时改为 `DATABASE_URL=sqlite:///./cmc_pms_lite.db`。
`APP_SECRET` 必须使用至少 32 字符的随机值，不能保留 `change-me` 示例。登录前还须填写真实 IAM 客户端密钥。

## IAM 登录（mb-casd / Casdoor）

采用「后端换码」方式：浏览器 → `GET /api/v1/auth/login` → Casdoor 授权页（授权码 + PKCE S256）→
`GET /api/v1/auth/callback` 由**后端**校验 state / nonce、用 client secret 换 token、RS256 + JWKS 验签，
再建立 **HttpOnly 会话 cookie**。access / id token 加密存于服务端，**不下发给前端 JavaScript**；
登出（`POST /api/v1/auth/logout`）先销毁业务会话，再跳 Casdoor `/api/logout` 清除 SSO。

1. **Casdoor 应用**：组织 `mabpharm`、应用 `mp-pm`（clientId `mppm-client-id-0001`）。在应用 redirectUris 中登记
   `{PMS_PUBLIC_URL}/api/v1/auth/callback` 与登出回跳 `{PMS_PUBLIC_URL}/login`（`localhost` / `127.0.0.1` 由 Casdoor 免登记）。
2. **后端 `.env`**（完整清单见 [`backend/.env.example`](../backend/.env.example)）：`CASDOOR_ENDPOINT`（浏览器访问的 IAM 地址 = token issuer）、
   `CASDOOR_CLIENT_SECRET`、`APP_SECRET`（≥32 字符随机值，兼作会话加密密钥）、`PMS_PUBLIC_URL`（用户访问本系统的 origin，
   本地开发为 `http://localhost:5175`）。后端在容器 / 内网中访问 IAM 时另设 `CASDOOR_INTERNAL_URL`。HTTPS 部署设 `IAM_COOKIE_SECURE=true`。
3. **账号与角色**：用户须先在 IAM 的 `mabpharm` 组织中分配**唯一**业务角色（admin / cmc_lead / project_lead / rd /
   production / qa_qc），并在本系统「组织」中预置**同用户名**的成员。首次登录按用户名关联，之后固定绑定 IAM 的
   issuer + sub；未预置、已停用或角色不唯一的账号无法登录。**授权只认 IAM 中的角色**，本地成员的角色字段仅作展示。
4. 直连 API 的脚本可用已绑定用户的 Casdoor access token（`Authorization: Bearer …`）。演示身份头 `DemoUser` 与
   本地签发的 JWT 已全部移除。
5. **账号开通**：统一由管理员在 IAM 平台管理；登录页显示「所有用户信息在 IAM 平台管理」。本系统已移除自助注册，
   旧 `/register` 链接返回登录页，旧 `/api/v1/auth/register` 接口返回 410。原 `IAM_SIGNUP_ENABLED` / `IAM_SIGNUP_ROLE`
   配置不再生效；已有账号继续按第 3 项的绑定与角色规则登录。
6. **修改用户名 / 密码**：左侧「设置 › 我的账号」（所有人可用；点顶栏自己的名字也可进入）。两项都要先输入当前密码，
   由后端经 IAM 校验后修改（错误次数计入 IAM 的登录失败锁定）：改用户名会同步 IAM 角色成员与本系统成员的用户名，
   绑定按 IAM sub 不受影响；改密码后，本系统在其他设备上的登录会退出。管理员在 IAM 控制台改过的用户名，
   也会在该用户下次登录时同步过来。

## 独立门户与会话

正式门户使用组织 `mabpharm` 下的独立 Casdoor 应用 `admin/maibo-portal`。
PM 保留 `mp-pm` 客户端。正式门户需配置 `PORTAL_PUBLIC_URL`、`PORTAL_CLIENT_ID` 和 `PORTAL_CLIENT_SECRET`；缺少完整配置时返回 503，不回退到 PM 客户端。

| 配置 | 用途 |
|---|---|
| `PORTAL_PUBLIC_URL` | 正式门户 origin：`https://www.openlims.ai` |
| `PORTAL_CLIENT_ID` | 门户自己的客户端 ID，用于 audience 验证 |
| `PORTAL_CLIENT_SECRET` | 门户客户端密钥，仅保存在后端 |
| `PORTAL_JWKS_URL` | 可选公钥端点覆盖，须包含门户签名证书 |
| `PMS_PUBLIC_URL` | 项目管理 origin：`https://pm.openlims.ai` |
| `CASDOOR_ENDPOINT` | 公网 IAM 地址，同时用于 issuer 验证 |
| `CASDOOR_INTERNAL_URL` | 后端换码及拉取公钥的内部地址 |
| `IAM_COOKIE_SECURE` | HTTPS 生产环境设为 `true` |

门户回调为 `https://www.openlims.ai/api/v1/portal/callback`，登出回跳为 `https://www.openlims.ai/login`。
PM 回调为 `https://pm.openlims.ai/api/v1/auth/callback`，登出回跳为 `https://pm.openlims.ai/login`。
各自 URI 登记在对应 IAM 应用中；`PORTAL_JWKS_URL` 留空时使用现有 IAM 公钥端点。
前后端保持同源，CORS 明确列出 www / pm，不使用通配符。

门户与 PM 使用独立登录 / 会话表和 Host-only Cookie，不共享 `.openlims.ai` Cookie，不在导航 URL 携带令牌。
退出工作台销毁当前门户会话并请求 IAM 退出；PM / KB 已有业务会话需要在各应用内分别退出。
一次登录后跨应用免输密码，依赖 IAM 应用的会话复用设置。2026-10-08 起，`maibo-portal`、`mp-pm`、`dikw-kb`、`dikw-web` 都已打开 `enableSigninSession` 和 `enableAutoSignin`，`cookieExpireInHours` 为 168：登录时勾选「下次自动登录」，IAM 会话保持 7 天，不勾选保持 24 小时（mb-casd ADR-0004）。
新增 IAM 应用时同样打开这两个开关；关掉 `enableSigninSession` 后，从该应用登录不再保留 IAM 会话，其他应用又要单独输密码。
开了自动登录后，换账号前要先退出工作台或 PM，清掉 IAM 会话。
真实用户登录和跨应用 SSO 的验收状态以部署记录为准。

本地 `PORTAL_PUBLIC_URL` 留空时兼容同域客户端及 PM 回调；真实访问 URL、回调和 Cookie origin 必须一致。
生产前端按域名选择门户或 PM 界面，同一镜像不固定 `VITE_APP_MODE`。
本地可选择 `portal` / `pm` / 默认组合模式，详见 [本地开发](development.md)。

## 账号开通与数据范围

- IAM 管用户名、密码及角色分配；PM 的成员记录用于团队、任务负责人及业务身份绑定。
- PM 用户需唯一的 PM 业务角色和有效业务成员；管理员 / CMC 负责人看全部，项目负责人看自己负责或参与的项目。
- 研发 / 生产人员看参与或有本人任务的项目，任务级仍限制在本人负责或协作任务；QA/QC 另含跨项目「分析方法 / 稳定性」任务。
- 财务与基线按可见项目收窄，服务端执行授权，界面隐藏入口不能替代鉴权。
- KB 需启用的 `kb_viewer` / `kb_editor`，同一用户可同时持有一个 PM 角色和一个 KB 角色。
- PM 根据经验签令牌中的角色判定权限；复核会话不等于实时查询 IAM 最新角色，角色变更生效需结合令牌有效期与各应用续期规则。

## AI 配置

管理员 / CMC 负责人在「设置 › AI 分析」维护模型地址、密钥、默认提示词及可选 Ollama 回退。
API Key 存在后端 `AI_SETTINGS_PATH` 指向的受保护文件中，生产使用持久卷；前端仅看到是否已设置。
留空保留原密钥，修改服务地址清除旧密钥。模型接收的数据范围、分析入口和报告行为见 [AI 功能说明](features.md#ai-设置与项目--财务分析)。
