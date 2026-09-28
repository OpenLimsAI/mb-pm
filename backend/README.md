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
| `APP_SECRET` | `change-me` | IAM 会话令牌加密密钥：须为 ≥32 字符随机值，否则登录返回 503 |
| `CASDOOR_ENDPOINT` | `http://localhost:8000` | 浏览器访问的 mb-casd（Casdoor）地址，也是 token `iss` 的期望值 |
| `CASDOOR_INTERNAL_URL` | 空（同上） | 后端访问 IAM 的地址（换 token / 拉 JWKS），容器 / 内网部署时使用 |
| `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` | `mppm-client-id-0001` / 空 | Casdoor 应用 `mp-pm` 的凭据，secret 只在后端 |
| `CASDOOR_ORG` | `mabpharm` | 只接受该组织的账号与角色 |
| `PMS_PUBLIC_URL` | `http://localhost:5175` | 用户访问本系统的 origin；回调 `{PMS_PUBLIC_URL}/api/v1/auth/callback` |
| `IAM_SESSION_SECONDS` / `IAM_COOKIE_SECURE` | `3600` / `false` | 会话最长时长；HTTPS 部署须设 `true` |
| `IAM_SIGNUP_ENABLED` / `IAM_SIGNUP_ROLE` | `true` / `rd` | 登录页自助注册开关；新账号的 IAM 角色（仅限 rd / production / qa_qc） |

## 数据模型（三级 WBS）

`User · Project · ProjectMember · SubProject · Task · TaskDependency · Template · TemplateVersion · ProjectFinance · ProjectBaseline · AuditLog`

IAM：`IAMIdentity`（issuer + sub ↔ 业务用户，一对一绑定）· `IAMSession`（会话 cookie 的 SHA-256 → 加密令牌）· `IAMLogin`（进行中的登录 state，10 分钟有效）。

## 认证与授权

- 每个请求都要求 IAM 身份：浏览器用 HttpOnly 会话 cookie（写操作另校验 `Origin` 必须等于 `PMS_PUBLIC_URL`，防 CSRF），
  脚本可用已绑定用户的 Casdoor access token（`Authorization: Bearer …`）。每次请求都重新做 RS256 / JWKS 验签，
  并校验 issuer、audience、有效期、组织、唯一角色和本地账号启用状态。
- **角色只取自 IAM token**（`roles[].name`），不读本地 `users.role`；首次登录按用户名关联**已预置**的业务用户，之后固定按 issuer + sub 绑定。
- 自助注册与本人改用户名 / 密码经后端调用 Casdoor 管理接口（凭据即应用 client id / secret，在 Casdoor 中具备管理权限，
  因此只开放固定几个操作）：目标一律限定在 `CASDOOR_ORG`；改名 / 改密按当前用户已绑定的 IAM sub 定位账号，
  并先经 Casdoor 校验当前密码。Casdoor 改名时按用户名（不分组织）改写角色成员，若其他组织的角色 / 权限里有同名成员则拒绝自助改名。
- 删除项目仅 admin / cmc_lead，即使是项目负责人（owner）也不能删除。
- 执行层（rd / production / qa_qc）更新自己的任务时，不能改负责人、关键路径 / 里程碑标记、计划起止和任务预算（`cost_budget`），只能录入实际花费等进展。

## 核心 API（`/api/v1`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/login?return_to=` | 发起 IAM 登录（302 到 Casdoor，授权码 + PKCE） |
| GET | `/auth/callback` | IAM 回调：换 token、验签、建立会话后回到 `return_to` |
| POST | `/auth/logout` | 销毁会话并跳 Casdoor 登出 |
| GET | `/auth/me` | 当前用户（角色来自 IAM） |
| GET | `/auth/config` | 规范登录入口 `login_url`、是否开放注册 `signup_enabled` |
| POST | `/auth/register` | 自助注册：IAM 建号 + 默认角色 + 业务成员（预绑定 IAM 身份）；同一来源 10 分钟最多 10 次 |
| POST | `/account/username` | 本人改用户名（需当前密码）：改 IAM 用户名并同步业务成员 |
| POST | `/account/password` | 本人改密码（需当前密码）：其他设备上的会话一并退出 |
| GET/POST | `/projects` | 列表 / 创建 |
| **POST** | **`/projects/import`** | **整包创建：项目+子项目+任务+依赖（模板实例化结果）** |
| GET/PATCH | `/projects/{id}` | 详情 / 更新 |
| DELETE | `/projects/{id}` | 删除（admin / cmc_lead）：连同子项目 / 任务 / 依赖 / 团队 / 财务 / 基线，保留用户账号 |
| GET | `/finances` | 可见项目的预算；`spent` = 任务实际花费合计（实时汇总），`task_budget` = 任务预算合计 |
| PUT | `/finances/{project_id}` | 设置 / 修改项目预算（admin / cmc_lead）：总预算、已承诺、成本结构、财年、备注；不接受 `spent`；写审计日志 |
| GET/POST | `/finances/ai-analyses` | 财务 AI 分析（admin / cmc_lead）：历史（最近 20 份，含是否过期）/ 生成 |
| GET | `/sub-projects?project_id=` | 子项目列表 |
| GET/POST | `/tasks` | 任务列表 / 创建 |
| **PATCH** | **`/tasks/{id}`** | **更新（含进展录入）→ 自动汇总子项目+项目进度** |
| GET | `/task-dependencies?project_id=` | 依赖列表 |
| GET | `/templates` | 模板列表（含 structure_json） |

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
