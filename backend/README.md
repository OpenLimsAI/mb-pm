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

## 配置（环境变量，可写入 `.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DATABASE_URL` | `sqlite:///./cmc_pms_lite.db` | 切 PostgreSQL：`postgresql+psycopg://user:pwd@host:5432/db`（需 `pip install "psycopg[binary]"`） |
| `AUTO_SEED` | `true` | 库为空时自动灌种子 |
| `APP_CORS_ORIGINS` | `http://localhost:5175,...` | 允许的前端来源 |
| `APP_SECRET` | `change-me` | JWT 签名密钥（生产务必修改） |

## 数据模型（三级 WBS）

`User · Project · ProjectMember · SubProject · Task · TaskDependency · Template · TemplateVersion · AuditLog`

## 核心 API（`/api/v1`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login` | 用户名登录，返回 JWT |
| GET | `/auth/me` | 当前用户 |
| GET/POST | `/projects` | 列表 / 创建 |
| **POST** | **`/projects/import`** | **整包创建：项目+子项目+任务+依赖（模板实例化结果）** |
| GET/PATCH/DELETE | `/projects/{id}` | 详情 / 更新 / 删除 |
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

## 技术栈

FastAPI · SQLAlchemy 2 · Pydantic 2 · SQLite/PostgreSQL · python-jose(JWT) · openpyxl。
