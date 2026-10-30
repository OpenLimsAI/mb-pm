# CMC-PMS · CTO Lite 后端（FastAPI + SQLite）

CTO 决策视图的后端服务，对应 URS-CMC-PMS-001 的「业务逻辑层 + 数据访问层」。
默认 **SQLite 单文件**，零外部依赖，开箱即跑；同一套 SQLAlchemy 代码可平滑切到 PostgreSQL。

## 一键启动

```bash
cd backend
./run.sh            # 首次自动建虚拟环境+装依赖，之后直接启动
```

或手动（需 Python 3.11+；推荐用 uv）：

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8000
```

启动后：
- API 基址： `http://127.0.0.1:8000/api/v1`
- 交互文档： `http://127.0.0.1:8000/docs`
- 首次启动若库为空，自动建表并灌入种子数据（22 用户 / DMP v3.6 模板 / 3 项目 × 33 任务）。
- 登录前先把 `.env.example` 复制为 `.env`，填好 IAM 配置（`CASDOOR_*`、`APP_SECRET`、`PMS_PUBLIC_URL`）。

## 配置（环境变量，可写入 `.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DATABASE_URL` | `sqlite:///./cmc_pms_lite.db` | 切 PostgreSQL：`postgresql+psycopg://user:pwd@host:5432/db`（需 `pip install "psycopg[binary]"`） |
| `AUTO_SEED` | `true` | 库为空时自动灌种子 |
| `APP_CORS_ORIGINS` | `http://localhost:5175,...` | 允许的前端来源 |
| `APP_SECRET` | `change-me` | IAM 会话与知识报告个人模型配置的加密密钥：须为 ≥32 字符随机值，稳定保留并妥善备份 |
| `CASDOOR_ENDPOINT` | `http://localhost:8000` | 浏览器访问的 mb-casd（Casdoor）地址，也是 token `iss` 的期望值 |
| `CASDOOR_INTERNAL_URL` | 空（同上） | 后端访问 IAM 的地址（换 token / 拉 JWKS），容器 / 内网部署时使用 |
| `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` | `mppm-client-id-0001` / 空 | Casdoor 应用 `mp-pm` 的凭据，secret 只在后端 |
| `CASDOOR_ORG` | `mabpharm` | 只接受该组织的账号与角色 |
| `PMS_PUBLIC_URL` | `http://localhost:5175` | 用户访问本系统的 origin；回调 `{PMS_PUBLIC_URL}/api/v1/auth/callback` |
| `IAM_SESSION_SECONDS` / `IAM_COOKIE_SECURE` | `3600` / `false` | 会话最长时长；HTTPS 部署须设 `true` |

## 数据模型（三级 WBS）

`User · Project · ProjectMember · SubProject · Task · TaskDependency · Template · TemplateVersion · ProjectFinance · ProjectBaseline · AuditLog`

IAM：`IAMIdentity`（issuer + sub ↔ 业务用户，一对一绑定）· `IAMSession`（会话 cookie 的 SHA-256 → 加密令牌）· `IAMLogin`（进行中的登录 state，10 分钟有效）。

知识报告个人模型：`SolutionAISettings`（表 `solution_ai_settings`，迁移 `007_solution_ai`），以 IAM `issuer + owner_id` 为复合主键，配置使用 `APP_SECRET` 加密，`revision` 用于乐观并发保护。该表不替代 PM 全局 AI 配置；本轮只在隔离测试库验证，未迁移生产。

## 认证与授权

- 每个请求都要求 IAM 身份：浏览器用 HttpOnly 会话 cookie（写操作另校验 `Origin` 必须等于 `PMS_PUBLIC_URL`，防 CSRF），
  脚本可用已绑定用户的 Casdoor access token（`Authorization: Bearer …`）。每次请求都重新做 RS256 / JWKS 验签，
  并校验 issuer、audience、有效期、组织、唯一角色和本地账号启用状态。
- **角色只取自 IAM token**（`roles[].name`），不读本地 `users.role`；首次登录按用户名关联**已预置**的业务用户，之后固定按 issuer + sub 绑定。
- 本系统自助注册已停用，账号由 IAM 平台开通；旧 `IAM_SIGNUP_ENABLED` / `IAM_SIGNUP_ROLE` 配置已移除，不能重新开启注册。
- 本人改用户名 / 密码经后端调用 Casdoor 管理接口（凭据即应用 client id / secret，在 Casdoor 中具备管理权限，
  因此只开放固定几个操作）：目标一律限定在 `CASDOOR_ORG`；改名 / 改密按当前用户已绑定的 IAM sub 定位账号，
  并先经 Casdoor 校验当前密码。Casdoor 改名时按用户名（不分组织）改写角色成员，若其他组织的角色 / 权限里有同名成员则拒绝自助改名。
- 删除项目仅 admin / cmc_lead，即使是项目负责人（owner）也不能删除。
- 执行层（rd / production / qa_qc）更新自己的任务时，不能改负责人、关键路径 / 里程碑标记、计划起止和任务预算（`cost_budget`），只能录入实际花费等进展。

## 核心 API（`/api/v1`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/login?return_to=` | 发起 IAM 登录（302 到 Casdoor，授权码 + PKCE；登录页嵌入式登录失败时的回退） |
| POST | `/auth/login/start` | 嵌入式登录开始（须本站 Origin）：保存 state / PKCE，返回 IAM `/api/login` 地址与应用、组织名；浏览器直接向 IAM 提交用户名 / 密码 |
| GET | `/auth/callback` | IAM 回调：换 token、验签、建立会话后回到 `return_to` |
| POST | `/auth/logout` | 销毁会话并跳 Casdoor 登出 |
| GET | `/auth/me` | 当前用户（角色来自 IAM） |
| GET | `/auth/config` | 规范登录入口 `login_url`；兼容旧前端的 `signup_enabled` 固定为 `false` |
| POST | `/auth/register` | 已停用，固定返回 410 和「所有用户信息在iam平台管理」，不创建账号 |
| POST | `/account/username` | 本人改用户名（需当前密码）：改 IAM 用户名并同步业务成员（日常入口已移到门户「设置」） |
| POST | `/account/password` | 本人改密码（需当前密码）：其他设备上的会话一并退出（PM「请先修改临时密码」页使用） |
| POST | `/portal/login/start` | 门户嵌入式登录开始（须门户 Origin），同 `/auth/login/start` |
| POST | `/portal/username`、`/portal/password` | 门户「设置 › 我的账号」：本人改用户名 / 密码（门户会话，需当前密码，须门户 Origin） |
| GET/PUT | `/ai/settings` | 项目管理「AI设置」的全局配置（admin / cmc_lead）；另有 POST `/ai/models`、`/ai/test`，门户兼容接口 `/portal/settings/ai/*` 沿用同一配置 |
| GET/PUT | `/solutions/ai/settings` | 本人知识报告模型配置；门户会话、同源写保护和临时密码守卫，旧修订号返回 409，读取仅返回 `key_set` |
| POST | `/solutions/ai/test` | 测试本人配置草稿，只发送固定短消息，不保存配置或返回原始服务响应 |
| POST | `/solutions/{id}/ask` | 依授权原文问答；`model_profile_id` 可选个人标识、`system` 或 `retrieval`，未传时取个人默认再兼容全局 |
| POST | `/solutions/{id}/polish` | 作者草稿的选中文字润色；`text` 最多 5,000 字，`instruction` 最多 1,000 字，沿用个人 / 企业生成模型，返回建议而不保存正文 |
| GET/POST | `/projects` | 列表 / 创建 |
| **POST** | **`/projects/import`** | **整包创建：项目+子项目+任务+依赖（模板实例化结果）** |
| GET/PATCH | `/projects/{id}` | 详情 / 更新 |
| DELETE | `/projects/{id}` | 删除（admin / cmc_lead）：连同子项目 / 任务 / 依赖 / 团队 / 财务 / 基线，保留用户账号 |
| GET | `/finances` | 可见项目的预算；`spent` = 任务实际花费合计（实时汇总），`task_budget` = 任务预算合计 |
| PUT | `/finances/{project_id}` | 设置 / 修改项目预算（admin / cmc_lead；旧角色 project_lead 限本人负责 / 参与的项目）：总预算、已承诺、成本结构、财年、备注；不接受 `spent`；写审计日志 |
| GET/POST | `/finances/ai-analyses` | 财务 AI 分析（admin / cmc_lead）：历史（最近 20 份，含是否过期）/ 生成 |
| GET | `/sub-projects?project_id=` | 子项目列表 |
| GET/POST | `/tasks` | 任务列表 / 创建 |
| **PATCH** | **`/tasks/{id}`** | **更新（含进展录入）→ 自动汇总子项目+项目进度** |
| GET | `/task-dependencies?project_id=` | 依赖列表 |
| GET | `/templates` | 模板列表（含 structure_json） |

个人模型支持 DeepSeek、MiniMax、GLM、OpenAI、`custom`，最多 20 组，同一服务商可保存多个模型。密钥留空仅对原服务商与原地址保留，清除须明确，变更服务商或地址不复用旧密钥；设置及测试校验错误不回显输入密钥。自托管可使用 HTTP(S) 与明确局域网地址，拒绝元数据、链路本地和特殊地址，DNS 固定 IP 后保留原域名 TLS 校验，禁用代理和重定向。具体字段、错误与参考地址见[知识报告个人模型](../docs/knowledge-solutions.md#个人模型配置)。

## 进度汇总（rollup）

`PATCH /tasks/{id}` 修改任务 `progress/status/actual_*` 后，`app/services/rollup.py` 自动重算：
子项目进度 = 其任务进度均值；项目进度 = 全部任务进度均值（状态随之派生）。

## 重新灌种子

```bash
# seed.json 由前端生成： cd <前端> && npx tsx scripts/dump-seed.mjs
rm -f cmc_pms_lite.db        # 清库
.venv/bin/python -m app.seed.seed_data   # 或直接重启服务（库空会自动灌）
```

重灌会重建全部用户，同时清空 IAM 绑定与会话：所有人需重新登录，首次登录时按用户名重新绑定。

## 技术栈

FastAPI · SQLAlchemy 2 · Pydantic 2 · SQLite/PostgreSQL · python-jose（RS256 验签）· httpx · cryptography（Fernet）· openpyxl。

知识报告对话主题：迁移 `008` 为 `solution_answers` 增加可空 `conversation_id` 和 `(solution_id, conversation_id)` 索引，保留旧问答，不回写旧行。问答请求可指定主题，历史回传主题标识；同主题最近六个问题仅用于理解，作者、报告与 issuer 隔离及当前来源校验保持。该功能复用原 ask/history 接口，无新增环境变量。启动时会为既有表幂等补齐该字段及索引；新表由 `create_all` 建立。上线前仍须备份，并在隔离的生产库副本验证。

独立个人笔记：门户 Cookie 访问 `/api/v1/notes`，新建、搜索、编辑和回收站恢复按 issuer/sub 隔离。009 迁移新增 `personal_notes`，不依赖 KB、PM 或报告表；写操作同源、revision 冲突保护，创建 UUID 支持重试。启动时 `create_all` 会为不存在的笔记表建表；上线前仍须备份并验证。详见[个人笔记](../docs/personal-notes.md)。

## AI 助手任务接口（本地实现）

独立入口 `/api/v1/assistant/tasks` 使用门户会话，不依赖 PM 成员或知识库角色。任务、消息与结果按 IAM issuer/sub 隔离；任务项目名仅作个人分组。`GET/POST /tasks` 列表与创建，`GET/PUT /tasks/{id}` 读取与修改，`POST /tasks/{id}/messages` 发送问题，`POST /tasks/{id}/trash` 和 `/restore` 提供可恢复移除。写请求要求同源并通过临时密码检查。

创建包含 UUID；修改与提问包含 revision，提问另带 request_id。已完成的同内容请求重试直接返回已保存消息，不追加重复轮次。模型等待前释放数据库读事务，回答完成后重新核对归属、回收站与 revision，再原子保存问答；模型失败或版本冲突不改写消息。并发生成不持有数据库锁，尚未保存的并发调用不承诺外部推理恰好执行一次。

消息请求可用 `data_sources` 选择 `projects` 和 `knowledge`；每轮按权限读取项目摘要或检索知识库，范围变更时不带历史应用回答。详见[AI 助手](../docs/ai-assistant.md)。模型复用个人加密设置与安全传输，可选个人默认模型或 `enterprise`（企业默认）。`retrieval` 在普通助手中不可用；本应用不执行联网搜索、业务写入、邮件、定时任务或工具动作。显式参考正文最长20,000字、问题12,000字、任务偏好4,000字；每任务最多100轮，推理最多带最近3轮的有界历史，应用数据场景仅保留历史问题。每条回答作为已保存消息，同时提供 Markdown 结果产物。

010 迁移新增 `assistant_tasks`、`assistant_messages` 和归属/顺序索引、请求唯一约束，启动时 `create_all` 会创建缺失的表；上线前仍须备份并验证。012 迁移记录每条消息的数据范围以校验重试；上线前需升级并验证。模型请求测试使用替身。
