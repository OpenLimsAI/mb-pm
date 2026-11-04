# 配置与权限

知识报告使用门户会话与独立的报告所有权。企业知识库连接见[知识报告说明](knowledge-solutions.md#企业知识库连接)，个人模型配置见[下文](#知识报告个人模型)；后端令牌不得写入前端环境或源码。

[返回 README](../README.md) · [本地开发](development.md) · [功能说明](features.md)

## 配置入口

- 前端：以 [`.env.local.example`](../.env.local.example) 为参考，在 `.env.local` 设置 API 开关及开发代理目标。
- 后端：以 [`backend/.env.example`](../backend/.env.example) 为参考，在 `backend/.env` 配置数据库、IAM 和会话密钥。
- 生产：沿用服务器已有受保护配置，具体变量及环境状态见 [部署交接简明](部署交接简明.md)。密码、私钥、客户端密钥与数据库不写入文档或仓库。

`backend/.env.example` 示例使用 PostgreSQL；本地使用 SQLite 时改为 `DATABASE_URL=sqlite:///./cmc_pms_lite.db`。
`APP_SECRET` 必须使用至少 32 字符的随机值，不能保留 `change-me` 示例。登录前还须填写真实 IAM 客户端密钥。

### 容器业务数据持久化

根目录、后端开发及并行部署 Compose 模板显式把全局 AI 设置放在 `AI_SETTINGS_PATH=/data/ai/ai-settings.json`，把知识源和历史行业信息原件放在 `INFORMATION_DATA_DIR=/data/information`；分别挂载 `ai_settings`、`information_originals` 命名卷。生产域名入口和 `app-direct` 必须使用同一数据库、同一 `APP_SECRET` 和这两个共享卷。卷默认按 Compose project 隔离；生产 project `mb-pm-v2` 对应现有的 `mb-pm-v2_ai_settings`、`mb-pm-v2_information_originals`，本地使用不同 project 名。

镜像预建两个数据目录并赋予 UID/GID `10001:10001`，供新建命名卷继承；不会自动修改既有卷的所有权。裸机 Python 的 `.local` 默认目录不变，本地预览也不连接生产卷。临时上传缓冲位于 `/tmp`，完成上传后反馈图片及业务结果进入数据库；`/tmp` 可使用 tmpfs，不能用来保存原件或配置。

已有容器不能直接挂新空卷覆盖原数据。先核对实际路径和完整 Compose 链，备份并停止相关写入，迁移文件及权限、校验数量/内容后再切换；已有生产卷则沿用精确名称。数据库与 `APP_SECRET` 必须成套备份：会话令牌及个人模型密钥均依赖该密钥解密。`docker compose down -v` 会删除命名卷，日常发布只替换应用镜像并保留当前全部挂载。发布工具的挂载保持检查不等于备份恢复演练。

助手任务、已发送问题、生成进度和部分草稿保存在数据库；重建时已在生成的请求可能中断，租约过期后明确标为中断并允许继续，排队请求由新进程领取。未发送的输入及报告未保存修改仍是浏览器恢复数据，不属于服务器持久卷。

## 知识报告个人模型

在知识报告研究助手内高亮的「AI模型设置」配置本人模型，支持 DeepSeek、MiniMax、Kimi、GLM、OpenAI 和 `custom` 兼容服务；每人最多 20 组，同一服务商可有多组。名称、基础地址和模型 ID 由用户填写，官方基础地址及参考链接见[个人模型配置](knowledge-solutions.md#个人模型配置)。PM 全局模型及提示词仍在项目管理「AI设置」由原授权角色管理；知识报告个人设置不修改该文件，也不改变原权限。未设个人默认时兼容企业默认配置，问答时还可明确选择企业默认或仅检索资料。

正文选中文字的问答与润色共用研究助手当前选择的模型。问答照常发送本次问题、选中文字上下文与检索到的授权证据；润色仅发送选中文字和可选措辞要求，不发送整篇报告或配方表，不执行资料检索。润色不能选择「仅检索资料」，未配置生成模型时明确提示；开发预览只演示本机文字整理，不调用外部模型。

个人模型的内部地址批准名单见下文。迁移 `007` 新增 `solution_ai_settings`，按已验证的 IAM `issuer + sub` 隔离，使用 `APP_SECRET` 加密整个配置后存库；部署前须规划迁移及备份。本轮尚未部署或修改生产库。密钥不会通过读取接口回显，读取只提供 `key_set`；省略或留空密钥仅在服务商及规范化地址未变时保留原值，`clear_key=true` 明确清除，换地址或服务商不继承旧密钥。稳定保管 `APP_SECRET` 及对应备份；更换前需规划已有密文的重加密，不能只替换环境值。

个人模型默认只允许公网 HTTPS；本机、RFC1918 局域网、IPv6 ULA 自托管模型必须由服务器管理员在 `AI_ALLOWED_INTERNAL_ORIGINS` 明确批准（逗号分隔的完整 `scheme://host:port`，无路径、通配符、凭据、查询或片段）。用户保存地址本身不构成批准，未获批准的内部 DNS 解析结果也会被拒绝。项目管理企业云模型仅允许 DeepSeek、MiniMax、Kimi 的官方 HTTPS 主机；企业内部模型同样使用批准名单。地址由**后端进程**访问，本机地址不代表用户浏览器所在电脑。批准名单也不放行云元数据、链路本地及其他特殊地址；DNS 含禁止地址时整次连接拒绝。两类模型连接均固定已校验 IP，保留原域名的 Host、TLS SNI 和证书验证，不使用环境代理、不跟随重定向。

生产若保留原 Ollama 地址，必须将 `AI_ALLOWED_INTERNAL_ORIGINS=http://127.0.0.1:11434` 透传至两个 PM 实例；不要写入任意内网网段或通配主机。修改配置后重建容器，官方 DeepSeek/MiniMax 地址无需加入名单。`custom` 可不带密钥；其他个人服务商可先保存无密钥配置，但实际提问或测试返回 422，不静默改用其他模型。

「测试连接」仅在用户点击后发送固定短消息，不带报告、论文或写作上下文，也不会保存配置。开发预览禁止输入真实密钥和测试，仅在浏览器隔离空间保存非秘密元数据，不生成真实回答。生产 `SOLUTION_KB_*` 的既有未配置记录不因个人模型功能改变；模型配置与企业知识权限是独立条件。

知识库复用工作台个人模型的服务端入口默认关闭，须按配套发布契约启用。配置与接口约定见[知识库统一模型接口](knowledge-ai-integration.md)。它复用上方个人配置与默认选择，不复制个人密钥，不扩大现有 PM／门户接口的令牌受众。

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
3. **账号与角色**：`mabpharm` 组织中启用的账号都能进入项目管理。项目管理角色（admin / cmc_lead / project_lead / rd /
   production / qa_qc）取 IAM 中最高的一个，没有则按员工（rd）。首次登录时：有同名且未绑定的成员就关联，没有就按 IAM
   资料自动建成员；之后固定绑定 IAM 的 issuer + sub。已停用的成员、或同名成员已绑定其他 IAM 账号时无法登录。
   **授权只认 IAM 中的角色**，本地成员的角色字段仅作展示。
4. 直连 API 的脚本可用已绑定用户的 Casdoor access token（`Authorization: Bearer …`）。演示身份头 `DemoUser` 与
   本地签发的 JWT 已全部移除。
5. **账号开通**：统一由系统管理员在门户「账号管理」开通（与 IAM 同步）；应用内不再链接 IAM 管理台。本系统已移除自助注册，
   旧 `/register` 链接返回登录页，旧 `/api/v1/auth/register` 接口返回 410。原 `IAM_SIGNUP_ENABLED` / `IAM_SIGNUP_ROLE`
   配置不再生效；已有账号继续按第 3 项的绑定与角色规则登录。
6. **修改用户名 / 密码**：门户工作台「我的设置」（`/settings`，所有人可用；项目管理顶栏点自己的名字、
   PM 旧 `/settings` 链接都会打开这里），走门户会话：`POST /api/v1/portal/username`、`POST /api/v1/portal/password`。
   两项都要先输入当前密码，由后端经 IAM 校验后修改（错误次数计入 IAM 的登录失败锁定）：改用户名会同步 IAM 角色成员
   与本系统成员（含尚未绑定的同名预置成员）的用户名，绑定按 IAM sub 不受影响；改密码后，本系统在其他设备上的登录会退出。
   管理员在 IAM 控制台改过的用户名，也会在该用户下次登录时同步过来。项目管理的 `/api/v1/account/*` 仍保留
   （「请先修改临时密码」页与 Bearer 调用使用）。
7. **登录页直接登录（嵌入式登录）**：门户与项目管理的登录页直接输入用户名和密码，不再跳到 IAM 登录页。登录页先调用
   `POST /api/v1/portal/login/start`（项目管理为 `/api/v1/auth/login/start`，须本站 Origin），后端照常保存 state / PKCE /
   nonce 并写 state cookie，返回带授权参数的 IAM `/api/login` 地址及应用名、组织名（经 IAM 公开接口 `get-app-login`
   查询并缓存 10 分钟）；浏览器把用户名和密码直接提交到该地址（`type=code`），拿到授权码后打开原有回调。密码不经过
   本系统后端；IAM 同时写入自己的登录会话（应用须保持「启用登录会话」），进入其他应用仍是单点登录。登录页打开时先用
   `/config` 返回的 `iam_session_url`（IAM `/api/get-account`）检查浏览器里是否已有 IAM 会话，有则不带密码向 `/api/login`
   换授权码（IAM 的快速登录），直接完成登录。IAM 返回两步验证等控制值（`NextMfa` / `RequiredMfa` 等）时改为跳转 IAM 登录页。
   **前提**：IAM 须允许门户 / PM 的 Origin 跨域携带凭据访问 `/api/login`（Casdoor 对本机地址及与应用回调地址同源的
   Origin 放行；2026-10-17 用预检请求核对生产 `iam.openlims.ai`：`www` 与 `pm` 均返回对应的 `Access-Control-Allow-Origin` 和 `Access-Control-Allow-Credentials: true`，其他 Origin 返回 403）。浏览器连不上
   IAM 时登录页自动改为跳转 IAM 登录页。实现见 `backend/app/services/iam_login.py`、`src/api/iamLogin.ts`。

## 独立门户与会话

门户与 PM 支持服务端续期。Casdoor 应用须允许 `authorization_code` 与 `refresh_token`；access、id、refresh token 均加密存入原有会话表，浏览器只持有 HttpOnly 随机会话 Cookie。默认在 access token 到期前 120 秒刷新，活跃操作不再每小时被中断；刷新使用该会话所属的独立客户端，不新增 scope。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `IAM_SESSION_SECONDS` | `3600` | 可续期会话的空闲时限；无刷新令牌的旧会话仍按原有上限过期 |
| `IAM_SESSION_ABSOLUTE_SECONDS` | `28800` | 自完整登录起最多 8 小时，刷新不会延长这个绝对时限 |
| `IAM_REFRESH_LEEWAY_SECONDS` | `120` | 短期访问令牌到期前的刷新窗口 |

升级不会为旧会话补造刷新令牌，用户须正常登录一次后进入续期模式。仅调大 `IAM_SESSION_SECONDS` 无法延长旧令牌的一小时寿命。IAM 的 7 天单点登录 Cookie 与上述业务会话时限分别生效。显式退出后不会自动恢复登录。

两个生产实例通过 PostgreSQL 会话行锁串行刷新，身份校验完成后立即释放锁，不持有到 AI 生成结束。刷新重新校验签名、issuer、client/audience、subject、组织、账号状态及原始授权链撤销标记；后续刷新不能越过统一退出。IAM 暂时故障或响应缺少有效的账号/令牌状态字段时返回 503，不授权请求、不删除会话或清除有效工作现场；`invalid_grant` 返回 401，要求重新登录。已成功旋转但状态核验暂时失败的新凭据会加密保留，下一次仍须重新核验才能使用。

单点登录探测区分已登录、未登录与暂无法确认，超时或跨域失败提供重试和顶层 IAM 入口，不等同账号已退出。`auth.audit` 输出 UTC 时间、随机请求 ID、路由模板、实例、HTTP 状态与安全原因码；响应含 `X-Request-ID`，鉴权失败另含 `X-Auth-Reason`。日志不包含账号、Cookie、令牌、查询参数、问答内容或模型密钥。常见原因码为 `session_missing`、`session_expired`、`session_idle`、`token_expired`、`revoked`、`account_disabled`、`provider_unavailable`、`refresh_rejected`。

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
- 账号与组织成员统一在门户「账号管理」维护（`/accounts`，系统管理员 `admin` 可改全部，项目负责人 `cmc_lead` / `project_lead` 只能查看，其他人看不到入口；项目管理不再提供组织页，旧 `/org` 跳到这里）：后端以 PM 的 IAM 应用凭据调用 Casdoor，只开放建号、改资料 / 权限、改名、重置密码、停用、删除几项固定操作，目标限定 `CASDOOR_ORG`；规则见 [功能说明](features.md#账号管理)。应用凭据在 Casdoor 中具备全局管理权限，所以接口每次请求实时核对管理员角色，写操作要求门户 Origin。
- 自动建成员或账号管理新建成员时，没有可用邮箱则用 `用户名@mabpharm.example` 占位（项目管理不发邮件，仅满足唯一约束）。
- 临时密码：账号管理新建 / 重置后写入 `iam_password_change_required`（按 IAM sub），本人经 `POST /api/v1/account/password` 或 `POST /api/v1/portal/password`（须当前密码）改密后清除；标记期间 `get_current_user` 与账号管理只放行查询身份、改密、退出（`services/password_policy.py`）。**不要在 IAM 管理台打开「需要更新密码」**：Casdoor 3.100.0 会把用户带到 IAM 自己的页面且不回到应用。
- 不要给 `mabpharm` 组织或应用设置「必须」级别的 MFA：Casdoor 会把用户带到 IAM 的 `/mfa/setup` 页面。
- 已绑定成员以 IAM 为准对账（`services/members.py` 的 `reconcile_with_iam`）：IAM 停用 / 删除 → 成员停用，启用 → 启用，姓名与用户名跟随；登录时、账号管理列表、`GET /api/v1/users`（每分钟最多一次）触发，IAM 不可用时跳过。
- 项目管理默认开放；系统管理员 / 项目负责人（`cmc_lead`）看全部，旧角色项目负责人（`project_lead`）看自己负责或参与的项目。
- 研发 / 生产人员看参与或有本人任务的项目，任务级仍限制在本人负责或协作任务；QA/QC 另含跨项目「分析方法 / 稳定性」任务。
- 财务与基线按可见项目收窄，服务端执行授权，界面隐藏入口不能替代鉴权。
- 系统管理员是单独的平台管理身份，对应 `admin`；PM 业务角色对应项目成员（默认 `rd`）或负责人 `cmc_lead`。修改 PM 角色不移除 `admin`；取消平台身份后回落到保留的业务角色。它不等同于 Casdoor 的 `isAdmin` 组织管理员属性。
- KB 准入识别启用的 `kb_manager` / `kb_editor` / `kb_viewer`。账号管理可选知识库负责人（`kb_manager`）或知识库用户（`kb_editor`），负责人选项在前；历史 `kb_viewer` 保留只读，只有明确选择角色并保存才升级。相应 IAM 角色须先创建并启用；平台管理员不自动获得 KB 负责人身份。配套服务与代理要求见[知识库权限交接](../deploy/knowledge-permissions/README.md)。
- 账号写接口使用 `platform_admin`、`pm_identity`、`kb_role`，KB 写入只接受 `manager` / `editor`；旧 `identity` 仅保留在读取响应中，旧字段写入及任意角色数组会被拒绝，避免整包覆盖平台权限。
- 启用 `OIDC_GLOBAL_LOGOUT_ENABLED` 并确认账号状态字段对本人可见后，PM 在经验签令牌绑定的同一账号/组织上逐请求读取当前启用角色；旧 JWT 中的角色快照不再决定权限。有效字段确认主体不匹配、停用或撤销时仍拒绝访问；身份服务响应缺字段不能被误当成已经撤权。

## 信息获取

### 知识源

新 `/knowledge-sources` 使用 `KNOWLEDGE_SOURCE_APP_ENABLED=true`；手动下载后台由 `KNOWLEDGE_SOURCE_WORKER_ENABLED` 控制，默认 `false`，生产发布时显式启用。复用原 `INFORMATION_KB_URL`、`INFORMATION_KB_SECRET` 和原文共享卷，不修改 Core 令牌。旧 `INFORMATION_APP_ENABLED=false` 必须保持，新后台只运行带知识源 app 标识的显式任务，不恢复旧监控。完整 Core 文献阅读仍需实时 KB 角色，文件夹整理需 `kb_manager`；`admin` 的 ICH 公开收录委托不扩大为全库权限。见[知识源](knowledge-sources.md)。

旧「行业信息」下线，总开关 `INFORMATION_APP_ENABLED` 默认 `false`。即使旧环境仍配置 `INFORMATION_WORKER_ENABLED=true`，关闭总开关也不会启动或执行采集，已登录的信息管理接口返回 410；既有原文下载保留原会话、实时 IAM、租户与版本授权；不删除或重写历史任务和原文。不要为查看新 UI 重新启用旧服务。生产部署须明确保留该关闭状态。

### 已下线历史实现（仅保留参考）

以下为旧接口历史配置，不作为新知识源启用步骤。

有效门户成员可浏览和订阅；系统管理员（`admin`）与知识库负责人（`kb_manager`）可管理来源、检查、收录及重试，后台每步实时核对 IAM。不会因此创建 PM 成员或授予普通知识库上传权限。

配置 `INFORMATION_WORKER_ENABLED=true`、持久化 `INFORMATION_DATA_DIR`（容器为 `/data/information`），`INFORMATION_MAX_ARCHIVE_MB` 默认 5120。两个 PM 实例必须共享相同数据卷和数据库，全局租约避免重复采集。
知识库收录另需 `INFORMATION_KB_URL` 指向内部 BFF，并将新生成的至少 32 字符密钥分别配置为 PM `INFORMATION_KB_SECRET`、KB `INFORMATION_BRIDGE_SECRET`。密钥按环境独立，0600 保存；不要复制已有 Core 令牌到 PM。仅连接三个应用容器的内部专用网络，不发布桥接端口。

默认 ICH 来源关闭监控。先检查官方清单，再批量收录到原文归档或真实知识库文件夹；手动开启监控后默认每日检查。详见[信息获取使用与部署](information.md)。


## MDM 公开入口与同域路径

`MDM_PUBLIC_URL` 是服务端受控的 MDM 应用基址，不是数据库连接串。门户 `/launch/mdm` 和 PM 项目深链均从它构造目标；生产地址使用 HTTPS，不接收浏览器传入的任意目标主机或身份令牌。MDM 自身的页面、资源、API 与登录回调共用 `/mdm/` 前缀，路径代理需保留此前缀。

2026-11-02 已将运行配置切换为 `https://www.openlims.ai/mdm/`；验收边界见[路径迁移记录](../deploy/parallel-test/releases/20261102-mdm-www-path.md)。PM 两个实例与 MDM 后端的 `MDM_PUBLIC_URL` 基址一致；MDM 的 `CORS_ORIGINS=https://www.openlims.ai`。Cloudflare 先匹配 `www.openlims.ai` 的 `^/mdm(/.*)?$` 并转发至 `http://mdm-web:80`，再由同主机空路径规则转发其余门户请求至 `http://app:8000`。规则从上往下采用首个匹配项，空路径规则在前会遮蔽 MDM 规则；同一主机的路径分流不新增 DNS 记录。

外部主机变化须同步 IAM 登录与独立 PM 委托客户端的 `homepageUrl`、精确 `redirectUris`，分别为 `/mdm/api/v1/auth/oidc/callback` 和 `/mdm/api/v1/auth/oidc/pm-callback`。已核验可达的内网 `backchannelLogoutUri` 按实际部署保留，不随公开域名机械替换。MDM host-only Cookie 路径为 `/mdm/`，名称与门户 / PM 不同；旧子域名会话不会自动迁入新主机。同域入口仍需各应用独立鉴权，不自动获得 MDM 角色，也不替代账号首次改密流程。

## MDM 委托创建与统一退出（默认关闭）

`MDM_DELEGATION_CLIENT_ID` 仅用于专门的用户委托创建/查询接口，须与 PM、门户及 MDM 登录客户端分离；空值时拒绝该功能。`MDM_SOURCE_NAMESPACE` 固定登记来源，不能由浏览器选择。PM 权限仍取已绑定用户的 PM 角色，MDM 角色不授予 PM 创建权。

`OIDC_GLOBAL_LOGOUT_ENABLED=true` 启用已验签的 `/api/v1/auth/backchannel-logout`，PM 和门户客户端分别登记同一地址，按精确 audience 撤销；还强制每次请求以对应应用客户端 Basic 认证调用 Casdoor 标准 introspection，active=false 拒绝、不可达 503，防止漏通知继续使用旧会话。委托 token 用 PM 自身客户端查状态，固定 Casdoor 3.152.0 要求同证书；不同证书安全拒绝，不共享 MDM secret。

带 sub 的已验签事件保守撤销本应用该主体的全部既有会话。统一退出调用 IdP logoutAll=true，影响该身份其他设备；局部退出仅结束当前应用浏览器会话。详见[第二阶段契约与限制](mdm-phase2.md)。此处描述代码行为，真实环境配置与浏览器验收由独立报告记录。


统一退出开启还要求 CASDOOR_ACCOUNT_STATUS_VISIBLE=true：这是部署者确认本组织 isForbidden/isDeleted 对本人未被字段规则遮蔽；默认 false，未确认时503，不自动授予权限。每次请求在 introspection 后用本人的同一access Header只读 get-user，固定组织+sub，不读全组织、不调用会生成token的get-account；禁用/删除403，状态缺失或错主体401，失败/超时503，无active缓存。该门槛不自动同步角色，也不等于永久撤销旧token；恢复/退出的精确边界见[本人状态补强](mdm-phase2.md#本人状态核验补强)。正式组织未验收保持默认关闭。
知识报告对话主题无新增环境变量；正式服务升级需要数据库迁移 `008`（主题标识与索引），先迁移后重启服务。个人模型设置仍使用 `007` 的独立加密表，访问权限与密钥配置保持原有规则。本轮只保留本地预览，未对生产数据库执行迁移。

工作台我的笔记为独立 `/notes`，门户目录增加 `notes.enabled`，有效门户账号均可使用；不要求 KB 角色或 `VITE_KNOWLEDGE_PORT`，不额外增加 IAM 角色。功能设置中的账号管理沿用 `accounts.enabled`；同版块的主数据管理沿用 `mdm.enabled` 和受保护的 `/launch/mdm` 入口。门户个人 AI 设置 `/model-settings` 复用研究报告的加密配置与预览存储，和 PM 的管理员 `/ai-settings` 分开。

个人笔记正式运行需执行 Alembic 到 `009`（包含此前研究报告 007/008 迁移），新建 `personal_notes`；不改写论文知识库数据。接口按门户会话隔离，写操作要求同源，临时密码需先更改。无新增环境变量。当前只在隔离测试库验证迁移，未执行生产迁移或部署。

AI 助手正式运行需迁移到 `012`，新建个人任务和消息表。门户目录增加 `assistant.enabled`，所有有效门户账号均可使用，不要求 PM 成员或 KB 角色；API 按 issuer/sub 隔离、同源写入并执行临时密码检查。个人模型沿用研究报告加密设置，无新增密钥环境变量；企业默认沿用已有服务端配置。浏览器预览不连接模型或生产数据。当前只在隔离库验证迁移与请求替身，未部署。

统一笔记的精确 CORS Origin 和可选后台检索连接：`KNOWLEDGE_NOTES_ORIGIN`、`NOTES_WISDOM_CORE_URL`、`NOTES_WISDOM_TOKEN`、`NOTES_WISDOM_WORKER_ENABLED`，配置说明见 [我的笔记](personal-notes.md#配置)。

此前个人助手移除项目相关功能的版本只提供知识库，忽略旧浏览器 `projects` 选择；当时无需新增迁移，发布范围见[发布记录](../deploy/parallel-test/releases/20261101-assistant-remove-projects.md)。当前开发预览单独恢复项目管理只读数据源，保持任务项目归类移除，并要求重新明确选择；升级要求见下方。

Kimi 支持、模型价格显示与静态价格目录的维护规则见[模型价格参考](model-pricing.md)。

## 助手公开搜索（开发预览）

个人助手恢复项目管理数据源的开发版本还需迁移 `015`，为消息增加内部 `application_scope`，记录实际使用的来源和可验证的项目范围；已有启动补列机制同时覆盖该列。部署前先备份并核对迁移，不只替换前端。没有新增 PM 令牌或浏览器凭据：读取使用当前门户身份，实时核对 IAM、已有有效 PM 账号及项目行级范围，不因勾选自动创建成员或扩大权限。无有效 PM 绑定时先进入项目管理完成正常关联，再重试；仅选项目管理不要求知识库配置。此版本尚未部署生产。

个人助手和研究助手共用搜索适配。默认 `ASSISTANT_WEB_PROVIDER=model`，管理员设置 `ASSISTANT_WEB_ENABLED=true` 后，搜索随当前选中模型切换：DeepSeek 使用其官方搜索，Kimi 使用其官方搜索；已有 `deepseek` 配置是 `model` 的兼容别名。企业默认与本人个人配置分别解析，不从其他模型或其他账号借用。只接受 provider=deepseek 的 HTTPS `api.deepseek.com`，或 provider=kimi 的 HTTPS `api.moonshot.cn` / `api.moonshot.ai` 根地址或 `/v1`；Kimi 保持所选账号的原区域，第三方代理密钥不转发给官方搜索。可选 `ASSISTANT_WEB_MAX_RESULTS` 默认 5、范围 1–8。只有显式选择 `ASSISTANT_WEB_PROVIDER=tavily` 时才使用服务端 `ASSISTANT_WEB_API_KEY`，不自动跨服务商回退。示例见 [`backend/.env.example`](../backend/.env.example)。默认禁用；浏览器只读取当前模型就绪状态，切换/保存后刷新，不接收密钥。生产需将变量透传至两个应用并重新创建容器，保留完整运行覆盖。

正式运行须先备份并执行 Alembic `014`，保留既有问答。本地 `?preview=1` 只演示模式与来源，不调用搜索服务；真实接口未配置时返回明确错误，不伪装成已联网。模型跟随搜索适配本身没有新增迁移；实际生产版本、联网结果和验收边界以发布记录为准。详见[自动问答与联网搜索](assistant-auto-search.md)。

## 生产前端构建参数

生产发布使用 `SOURCE_REVISION=<固定完整提交> npm run build:production`，该入口固定 `VITE_USE_API=true` 和 `VITE_API_URL=/api/v1`，Vite 根据实际构建环境写入不含密钥的产物清单。普通开发/预览构建仍允许关闭 API。前端环境变量在编译时内联，不能用运行容器环境变量补救错误静态包；校验、预构建镜像和匿名登录检查见[生产构建检查](production-build.md)。

## 助手可靠性与运行管理

017增量迁移新增任务摘要/置顶/最终成果、结构化来源、请求首段时间及 `assistant_operations_config`。后台队列默认每人待处理3、每人同时生成1、全局排队100，可在门户AI设置的管理员运行面板修改并存入数据库；环境初值为 `ASSISTANT_PER_USER_PENDING`、`ASSISTANT_PER_USER_RUNNING`、`ASSISTANT_GLOBAL_QUEUED`。仅实时IAM系统管理员可读写运行面板，无新增密钥。

保留期默认0（不清理）；7–365天仅定义显式清理的范围，管理员须再次确认。每批最多1000条终态请求的重复输入与未完成稿；正式任务、消息和诊断状态保留。详情见[AI助手](ai-assistant.md)。部署状态以本次发布回执为准。
