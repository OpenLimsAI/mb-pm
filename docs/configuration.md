# 配置与权限

知识报告使用门户会话与独立的报告所有权。企业知识库连接见[知识报告说明](knowledge-solutions.md#企业知识库连接)，个人模型配置见[下文](#知识报告个人模型)；后端令牌不得写入前端环境或源码。

[返回 README](../README.md) · [本地开发](development.md) · [功能说明](features.md)

## 配置入口

- 前端：以 [`.env.local.example`](../.env.local.example) 为参考，在 `.env.local` 设置 API 开关及开发代理目标。
- 后端：以 [`backend/.env.example`](../backend/.env.example) 为参考，在 `backend/.env` 配置数据库、IAM 和会话密钥。
- 生产：沿用服务器已有受保护配置，具体变量及环境状态见 [部署交接简明](部署交接简明.md)。密码、私钥、客户端密钥与数据库不写入文档或仓库。

`backend/.env.example` 示例使用 PostgreSQL；本地使用 SQLite 时改为 `DATABASE_URL=sqlite:///./cmc_pms_lite.db`。
`APP_SECRET` 必须使用至少 32 字符的随机值，不能保留 `change-me` 示例。登录前还须填写真实 IAM 客户端密钥。

## 知识报告个人模型

在知识报告研究助手内高亮的「AI模型设置」配置本人模型，支持 DeepSeek、MiniMax、GLM、OpenAI 和 `custom` 兼容服务；每人最多 20 组，同一服务商可有多组。名称、基础地址和模型 ID 由用户填写，官方基础地址及参考链接见[个人模型配置](knowledge-solutions.md#个人模型配置)。PM 全局模型及提示词仍在项目管理「AI设置」由原授权角色管理；知识报告个人设置不修改该文件，也不改变原权限。未设个人默认时兼容企业默认配置，问答时还可明确选择企业默认或仅检索资料。

正文选中文字的问答与润色共用研究助手当前选择的模型。问答照常发送本次问题、选中文字上下文与检索到的授权证据；润色仅发送选中文字和可选措辞要求，不发送整篇报告或配方表，不执行资料检索。润色不能选择「仅检索资料」，未配置生成模型时明确提示；开发预览只演示本机文字整理，不调用外部模型。

无需新增模型环境变量。迁移 `007` 新增 `solution_ai_settings`，按已验证的 IAM `issuer + sub` 隔离，使用 `APP_SECRET` 加密整个配置后存库；部署前须规划迁移及备份。本轮尚未部署或修改生产库。密钥不会通过读取接口回显，读取只提供 `key_set`；省略或留空密钥仅在服务商及规范化地址未变时保留原值，`clear_key=true` 明确清除，换地址或服务商不继承旧密钥。稳定保管 `APP_SECRET` 及对应备份；更换前需规划已有密文的重加密，不能只替换环境值。

个人模型地址允许 HTTP(S) 及明确的本机、RFC1918 局域网、IPv6 ULA 自托管服务。地址由**后端进程**访问，本机地址不代表用户浏览器所在电脑。拒绝 URL 凭据、查询、片段、歧义 IP、云元数据、链路本地及其他特殊地址；DNS 含禁止地址时整次连接拒绝。连接固定已校验 IP，保留原域名的 Host、TLS SNI 和证书验证，不使用环境代理、不跟随重定向。`custom` 可不带密钥；其余四类可先保存无密钥配置，但实际提问或测试返回 422，不静默改用其他模型。

「测试连接」仅在用户点击后发送固定短消息，不带报告、论文或写作上下文，也不会保存配置。开发预览禁止输入真实密钥和测试，仅在浏览器隔离空间保存非秘密元数据，不生成真实回答。生产 `SOLUTION_KB_*` 的既有未配置记录不因个人模型功能改变；模型配置与企业知识权限是独立条件。

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
- PM 根据经验签令牌中的角色判定权限；复核会话不等于实时查询 IAM 最新角色，角色变更生效需结合令牌有效期与各应用续期规则。

## 信息获取

有效门户成员可浏览和订阅；系统管理员（`admin`）与知识库负责人（`kb_manager`）可管理来源、检查、收录及重试，后台每步实时核对 IAM。不会因此创建 PM 成员或授予普通知识库上传权限。

配置 `INFORMATION_WORKER_ENABLED=true`、持久化 `INFORMATION_DATA_DIR`（容器为 `/data/information`），`INFORMATION_MAX_ARCHIVE_MB` 默认 5120。两个 PM 实例必须共享相同数据卷和数据库，全局租约避免重复采集。
知识库收录另需 `INFORMATION_KB_URL` 指向内部 BFF，并将新生成的至少 32 字符密钥分别配置为 PM `INFORMATION_KB_SECRET`、KB `INFORMATION_BRIDGE_SECRET`。密钥按环境独立，0600 保存；不要复制已有 Core 令牌到 PM。仅连接三个应用容器的内部专用网络，不发布桥接端口。

默认 ICH 来源关闭监控。先检查官方清单，再批量收录到原文归档或真实知识库文件夹；手动开启监控后默认每日检查。详见[信息获取使用与部署](information.md)。


## MDM 委托创建与统一退出（默认关闭）

`MDM_DELEGATION_CLIENT_ID` 仅用于专门的用户委托创建/查询接口，须与 PM、门户及 MDM 登录客户端分离；空值时拒绝该功能。`MDM_SOURCE_NAMESPACE` 固定登记来源，不能由浏览器选择。PM 权限仍取已绑定用户的 PM 角色，MDM 角色不授予 PM 创建权。

`OIDC_GLOBAL_LOGOUT_ENABLED=true` 启用已验签的 `/api/v1/auth/backchannel-logout`，PM 和门户客户端分别登记同一地址，按精确 audience 撤销；还强制每次请求以对应应用客户端 Basic 认证调用 Casdoor 标准 introspection，active=false 拒绝、不可达 503，防止漏通知继续使用旧会话。委托 token 用 PM 自身客户端查状态，固定 Casdoor 3.152.0 要求同证书；不同证书安全拒绝，不共享 MDM secret。

带 sub 的已验签事件保守撤销本应用该主体的全部既有会话。统一退出调用 IdP logoutAll=true，影响该身份其他设备；局部退出仅结束当前应用浏览器会话。详见[第二阶段契约与限制](mdm-phase2.md)。此处描述代码行为，真实环境配置与浏览器验收由独立报告记录。


统一退出开启还要求 CASDOOR_ACCOUNT_STATUS_VISIBLE=true：这是部署者确认本组织 isForbidden/isDeleted 对本人未被字段规则遮蔽；默认 false，未确认时503，不自动授予权限。每次请求在 introspection 后用本人的同一access Header只读 get-user，固定组织+sub，不读全组织、不调用会生成token的get-account；禁用/删除403，状态缺失或错主体401，失败/超时503，无active缓存。该门槛不自动同步角色，也不等于永久撤销旧token；恢复/退出的精确边界见[本人状态补强](mdm-phase2.md#本人状态核验补强)。正式组织未验收保持默认关闭。
知识报告对话主题无新增环境变量；正式服务升级需要数据库迁移 `008`（主题标识与索引），先迁移后重启服务。个人模型设置仍使用 `007` 的独立加密表，访问权限与密钥配置保持原有规则。本轮只保留本地预览，未对生产数据库执行迁移。

工作台我的笔记为独立 `/notes`，门户目录增加 `notes.enabled`，有效门户账号均可使用；不要求 KB 角色或 `VITE_KNOWLEDGE_PORT`，不额外增加 IAM 角色。业务管理中的账号管理沿用 `accounts.enabled`。门户个人 AI 设置 `/model-settings` 复用研究报告的加密配置与预览存储，和 PM 的管理员 `/ai-settings` 分开。

个人笔记正式运行需执行 Alembic 到 `009`（包含此前研究报告 007/008 迁移），新建 `personal_notes`；不改写论文知识库数据。接口按门户会话隔离，写操作要求同源，临时密码需先更改。无新增环境变量。当前只在隔离测试库验证迁移，未执行生产迁移或部署。

AI 助手正式运行需迁移到 `012`，新建个人任务和消息表。门户目录增加 `assistant.enabled`，所有有效门户账号均可使用，不要求 PM 成员或 KB 角色；API 按 issuer/sub 隔离、同源写入并执行临时密码检查。个人模型沿用研究报告加密设置，无新增密钥环境变量；企业默认沿用已有服务端配置。浏览器预览不连接模型或生产数据。当前只在隔离库验证迁移与请求替身，未部署。
