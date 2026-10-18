# 本地开发与测试

[返回 README](../README.md) · [配置与权限](configuration.md) · [后端说明](../backend/README.md)

## 环境要求

使用 Node.js 20.19+（与 Docker / CI 的 Node 20 系列一致）及 Python 3.11。
前端默认为 `http://localhost:5175`，FastAPI 默认监听 `127.0.0.1:8000`。
真实登录需要可访问的 mb-casd IAM、对应客户端密钥及已开通的账号；本仓库不包含可用的生产登录凭据。

## 只预览界面

在项目根目录执行：

```sh
npm ci
VITE_USE_API=false npm run dev
```

打开 `http://localhost:5175/login`，点击「界面预览」查看门户；`/settings?preview=1` 预览「我的设置」个人账号页。
预览仅在开发模式开放，明确标记身份未经验证，禁用真实应用跳转及退出。
项目管理演示界面可从 `/dashboard` 进入；此模式不验证 IAM 登录，也不连接客户数据库。
需要沿用 5176 端口时可执行 `VITE_USE_API=false npm run dev -- --host 127.0.0.1 --port 5176`。

## 连接本地后端与 IAM

首次在项目根目录复制示例；已有配置时直接编辑自己的文件：

```sh
npm ci
cp -n .env.local.example .env.local
cp -n backend/.env.example backend/.env
```

编辑 `.env.local`：

```dotenv
VITE_USE_API=true
VITE_API_URL=/api/v1
API_PROXY_TARGET=http://127.0.0.1:8000
```

编辑 `backend/.env`，填写以下值：

- 本地 SQLite：`DATABASE_URL=sqlite:///./cmc_pms_lite.db`。示例原为 PostgreSQL，不能原样复制后假定无需数据库服务。
- `APP_SECRET`：至少 32 字符的随机值，可用 `openssl rand -hex 32` 生成；不要提交生成值。
- `CASDOOR_ENDPOINT`、`CASDOOR_CLIENT_ID`、`CASDOOR_CLIENT_SECRET`：使用实际 IAM 地址及 PM 客户端配置。
- `PMS_PUBLIC_URL=http://localhost:5175`、`APP_CORS_ORIGINS=http://localhost:5175`；使用 127.0.0.1 或其他端口时同步更改。
- 本地同域联调可将 `PORTAL_PUBLIC_URL` 留空；生产独立门户的配置见配置文档。

分别在两个终端启动：

```sh
# 终端 1：项目根目录进入后端
cd backend
./run.sh
```

```sh
# 终端 2：项目根目录
npm run dev
```

后端脚本首次创建虚拟环境并安装运行依赖；默认空库会初始化演示业务数据。
真实 PM 登录需要启用的业务组织账号，首次进入时关联同名未绑定成员或自动创建成员；业务权限按已验签的 IAM 角色判定。
API 文档位于 `http://127.0.0.1:8000/docs`。

如果本地 IAM 已占用 8000，业务后端改用 `PORT=8002 ./run.sh`，并把 `.env.local` 中
`API_PROXY_TARGET` 改为 `http://127.0.0.1:8002`。浏览器仍从 5175 访问，回调不要改成后端端口。
Vite 设置了 `strictPort`，前端端口被占用时会报错；改端口时同步 origin 配置及 IAM 回调。
IAM 换码及公钥拉取的内部地址可用 `CASDOOR_INTERNAL_URL` 覆盖，issuer 仍使用公网地址。

## 本地知识库入口

从本机开发工作台点击知识库，默认进入同一主机的 4322 端口，例如
`http://localhost:5185` → `http://localhost:4322/`。卡片同步显示本地地址，
不再跳到客户的 `kb.openlims.ai`。生产构建及正式域名始终使用生产知识库入口。
如本地知识库使用其他端口，在门户 `.env.local` 设置 `VITE_KNOWLEDGE_PORT` 后重启 Vite。

本工作区的独立知识库前端启动命令：

```sh
cd ../integrations/dikw-mbweb-customer
npm run dev
```

该开发前端仅提供本地界面，不代表已启动 Core、配置 IAM 或模型服务。
本地没有 Core 时不能读取论文，完整的权限、翻译及问答联调需要另行配置知识库后端；
不会通过这个本地入口自动复制或连接客户生产数据库和密钥。

## 构建与测试

前端构建及门户路由核对（项目根目录）：

```sh
npm run build
npm run test:coverage
node scripts/test-portal-routing.mjs
```

构建会先生成版本更新 HTML，再做 TypeScript 检查及 Vite 编译。
门户脚本核对域名分流、固定应用目标、深链接和不安全返回地址，不访问真实 IAM。
Vitest 使用 jsdom、Testing Library 和 MSW 测试真实界面及 HTTP 客户端。账号权限覆盖范围包括 `src/components/accounts/`、`PortalAccounts.tsx`、`accountAdmin.ts`、`api/accounts.ts`，逐文件要求语句、行、函数、分支均不低于 90%；报告输出到 `coverage/`。其他业务模块不计入该新功能门槛。

后端测试依赖需额外安装；`run.sh` 只安装运行依赖。在 `backend` 目录执行：

```sh
# 已按上文建立 .venv；使用 uv 安装测试依赖
uv pip install --python .venv -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

没有 uv 时，以 `python3.11 -m venv .venv` 建立带 pip 的环境，再使用
`.venv/bin/python -m pip install -r requirements-dev.txt` 安装依赖。
测试默认使用临时 SQLite 及测试签名密钥，不连接真实 IAM。
账号权限及门户接口的分支覆盖率检查（在 `backend` 目录）为：

```sh
python -m pytest tests/ -q --cov=app.services.accounts --cov=app.schemas.accounts --cov=app.api.v1.accounts --cov=app.api.v1.portal --cov-branch --cov-fail-under=90 --cov-report=term-missing --cov-report=json:coverage.json
```

该命令需要 `requirements-dev.txt` 中的 `pytest-cov`，门槛统计上述模块，JSON 保留行与分支明细。Windows 的虚拟环境解释器为 `.venv\Scripts\python.exe`。真实 IAM / KB 登录验收不由这些替身接口测试替代。
设置 `TEST_DATABASE_URL` 可改用专用测试 PostgreSQL；测试会重建表，只能指向可清空的测试库。

## CI 与验收范围

GitHub Actions 检查前端账号权限覆盖率、门户路由及构建、后端格式、PostgreSQL 测试及账号接口覆盖率、Docker 镜像构建；ESLint / Ruff lint 目前仅报告问题。
工作流配置见 [CI](../.github/workflows/ci.yml)。CI 使用 PostgreSQL 16，客户部署配置使用 18，升级前须关注版本差异。
自动测试通过不能代替真实用户换码、跨应用 SSO、业务权限及生产升级验收，具体步骤见部署交接。
