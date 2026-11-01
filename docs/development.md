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

知识报告的原知识库资料模块需要配套 KB 的资料嵌入版本。在该 KB 仓库运行：

```sh
KB_LIBRARY_PREVIEW=1 VITE_PORTAL_PORT=5190 npm run dev
```

当前报告界面本地预览用 `VITE_USE_API=false npm run dev -- --host 127.0.0.1 --port 5190 --strictPort` 启动；访问 `http://127.0.0.1:5190/solutions?preview=1`。上例通过 `VITE_PORTAL_PORT=5190` 让知识库返回当前工作台并保留预览标识。

保持两边都使用 `127.0.0.1`（或都使用 `localhost`），在门户 `/solutions?preview=1` 查看。默认知识库端口为 4322，可用 `VITE_KNOWLEDGE_PORT` 调整门户入口。该模式只在 Vite serve 显式开启，使用进程内示例资料，重启会重置文件和文件夹；不连接 IAM、Core 或模型，笔记仍使用原浏览器预览存储。正式登录联调应启动正常 KB BFF，不带预览开关。

## 连接本地后端与 IAM

本机调试实例（2026-10-27）使用 `http://localhost:5190`，本地 IAM 在 8001，业务后端在 8000，独立知识库在 4322，知识库 Core 在 8765。保持使用 `localhost` 登录和访问，以匹配现有本机 IAM 与知识库回调。业务数据存于本工作树 `backend/local-debug.db`，与原有本地业务数据库分开；首次运行会初始化示例项目。知识库使用已有独立本机 Core 数据。

本机已在忽略的 `.env.local` 与 `backend/.env` 配置真实 API、本地登录与数据库；`backend/.local/run-local-backend.py` 连接本地 Core 并启用行业信息任务，`backend/.local/run-local-knowledge.py` 启动同一身份服务下的知识库与本地收录桥接。两者读取本机既有的私有配置和单独生成的本地桥接密钥，不应提交。需要先启动现有本地 IAM、Ollama 与本地 Core，再分别运行：

```sh
# 后端（工作树 backend 目录）
/Users/bruce/Documents/00_Projects/1.MBERP/项目管理系统_Lite-iam/backend/.venv/bin/python .local/run-local-backend.py
# 知识库（knowledge-library 工作树目录）
/Users/bruce/Documents/00_Projects/1.MBERP/项目管理系统_Lite-iam/backend/.venv/bin/python ../knowledge-solutions/backend/.local/run-local-knowledge.py
# 工作台（knowledge-solutions 工作树目录）
npm run dev -- --host 127.0.0.1 --port 5190 --strictPort
```

前端与后端在未登录时均要求身份验证；本机资料接口与登录初始化已检查，实际账号登录、个人权限、模型回答及完整采集流程仍需由用户登录后验证。此调试实例不使用生产数据库，未部署生产。

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

后端脚本首次创建虚拟环境并安装运行依赖；默认使用 `backend/.venv`，也可通过 `VENV_DIR=.venv-runtime ./run.sh` 指定其他环境。默认空库会初始化演示业务数据。
真实 PM 登录需要启用的业务组织账号，首次进入时关联同名未绑定成员或自动创建成员；业务权限按已验签的 IAM 角色判定。
API 文档位于 `http://127.0.0.1:8000/docs`。

如果本地 IAM 已占用 8000，业务后端改用 `PORT=8002 ./run.sh`，并把 `.env.local` 中
`API_PROXY_TARGET` 改为 `http://127.0.0.1:8002`。浏览器仍从 5175 访问，回调不要改成后端端口。
Vite 设置了 `strictPort`，前端端口被占用时会报错；改端口时同步 origin 配置及 IAM 回调。
IAM 换码及公钥拉取的内部地址可用 `CASDOOR_INTERNAL_URL` 覆盖，issuer 仍使用公网地址。

## 本地知识库入口

从本机开发工作台点击知识库，默认进入同一主机的 4322 端口，例如
`http://localhost:5185` → `http://localhost:4322/`。卡片同步显示本地地址，
不再跳到客户的 `kb.openlims.ai`。生产构建及正式域名始终使用生产知识库入口。卡片在当前标签页打开，不新建标签页，知识库内的「应用工作台」可返回门户。
如本地知识库使用其他端口，在门户 `.env.local` 设置 `VITE_KNOWLEDGE_PORT` 后重启 Vite。

2026-10-26 知识库入口统一：工作台现有 9 项测试、门户路由脚本、相关 ESLint、TypeScript 与构建通过。浏览器确认同一标签页由 5190 进入 4322，再通过「应用工作台」返回，前后标签数量均为 6。正式准入路由与预览目标保持，仅本地预览，未推送或部署。

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

`ProjectCreate.test.tsx` 覆盖空白与模板创建切换、无模板时创建、预算校验和失败重试；后端 `tests/test_blank_project.py` 使用独立测试库核对零任务保存、后续添加首个任务及创建权限，不写入本地业务库或客户生产数据。

`Tasks.test.tsx` 和 `taskOrder.test.ts` 覆盖跨项目 WBS 排序、日期相同或逆序、旧数据兜底、筛选后相对顺序、权限范围及数据同步后的顺序更新。

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

## 信息获取本地使用

信息获取从工作台卡片或 `/information` 进入，复用门户会话。仅在 `VITE_USE_API=false` 的开发预览可直接打开 `/information?preview=1`；页面常驻演示标识。
真实 API 模式连接持久后端，并按[配置说明](configuration.md#信息获取)启用 worker 与可选 KB 桥接。原文使用独立目录，不指向客户备份。预览仅使用内存演示数据，不能写真实接口；真实接口失败不会回落到演示资料。详见[信息获取](information.md)。

## 知识报告开发

开发预览可直接打开 `/solutions?preview=1`（`VITE_USE_API=false`），不连接真实服务。正式模式需要门户登录及后端，方案使用数据库持久化。企业知识库适配另需服务端连接配置；没有模型配置时返回资料检索结果，不假装生成 AI 回答。完整范围见[应用说明](knowledge-solutions.md)。

2026-10-25 工作台版块与应用入口：前端 37 个文件、464 项测试、类型检查、20 个相关文件 ESLint 通过。覆盖桌面卡片顺序、账号管理条件显示、KB 笔记共享准入、待开发占位不可跳转、个人模型共用存储及预览密钥/测试禁用、报告主页保存成功/失败；浏览器确认笔记原页面、原有四组模型及报告列表往返。当前显示名称为研究报告/行业信息，内部路由与数据键不变。新增 `/model-settings` 属于门户会话，PM 管理员 `/ai-settings` 保持原样。仅本地预览，未推送或部署；此前对话主题后端 266 项仍为本轮前序验证，本次门户阶段未修改后端。

2026-10-25 对话主题与正文空间调整：前端 36 个文件、457 项测试，后端相关 265 项隔离回归及 1 项本机模拟 HTTP 连接测试通过，共 266 项；新测试覆盖主题持久化、连续追问、草稿切换、异步回包归属、逐条采纳与撤销、作者/报告/issuer 隔离、旧问答兼容、主题长度限制与迁移重复升级/降级。类型检查、9 个相关前端文件 ESLint 和 6 个相关 Python 文件 Ruff 通过。浏览器在 2370 × 1746 视口核对保存状态与专注开关约 8 像素间距、正文输入区域约 978 × 1241 像素（此前短正文最低 240 像素），主题切换、新建、插入确认、取消和专注往返；专注正文高约 1533 像素。1267 × 713 下状态缩为图标且无重叠。只修改本地预览，正式部署需要迁移 008，未推送、迁移或部署生产。

2026-10-25 文档导入与顶栏调整：前端 34 个测试文件、450 项测试通过，类型检查、本轮导入及入口相关文件 ESLint、Vite 构建通过；覆盖格式拒绝、UTF-8、正文分段不丢字、预览确认、原稿保存冲突、创建重试和取消。浏览器已核对 Word 中文、PDF 正文和需 CMap 的中文 PDF 预览，以及顶栏按钮顺序；扫描件不做 OCR。四应用统一返回入口和移除提交按钮已核对，配套 KB 本轮 3 文件 23 项测试、类型检查、4 个相关文件 ESLint 和前端构建通过。信息获取原有 `set-state-in-effect` 全仓 lint 问题仍在，本轮仅改其入口样式。无后端改动，未重跑后端测试；仅本地预览，未推送或部署。导入说明见[文档导入](knowledge-solutions.md#文档导入)。

2026-10-25 选中文字助手与精简撰写已通过本地检查：前端 32 文件427项测试（限制并发为4避免本机资源竞争）、类型检查、21个相关文件ESLint和Vite构建通过；后端相关256项隔离测试、1项本机HTTP模拟服务测试通过，共257项（新增14项润色用例）。Ruff检查与格式检查通过。润色只返回建议，替换后走既有文字编辑、自动保存与撤销；当前预览仅整理空格标点，不调用外部模型。界面取消独立摘要行，标题可直接编辑，布局位于全局顶栏，AI模型设置只保留在助手内，配方表编辑界面已移除而数据保留。继续仅本地预览，未推送或部署。复验前端可执行 `npx vitest run --maxWorkers=4`；后端原有个人模型回归清单加 `tests/test_solution_polish.py`，本机HTTP测试需要临时监听本地端口。

2026-10-25 后续模块尺寸与 AI 入口调整已通过本地验证：桌面四种布局的分隔线可拖动调宽高，窄屏堆叠可调整上下模块高度，支持键盘调整和双击还原。首次使用默认尺寸，偏好单独保存在浏览器；调整不触发报告业务保存，不重新挂载 iframe、编辑器或问答卡片，专注模式返回后恢复之前分栏尺寸。「AI 设置」紧邻「排列布局」，专注模式在右侧工具栏底部与「布局」相邻，助手内入口保留。前端 30 个测试文件、413 项测试、`tsc -b`、7 个本轮相关 TypeScript / TSX 文件 ESLint、Vite 构建和差异检查通过。浏览器已核对 1280 像素桌面左右 / 上下拖动、675 像素窄屏高度拖动、双击恢复、隐藏 / 专注往返，以及 375 像素下布局与 AI 按钮并排且无横向溢出。本轮无后端改动，未重跑后端测试；未推送或部署，下列 358 项前端、243 项后端保持为上一轮个人多模型的独立历史。

2026-10-25 新增个人多模型本地预览：「AI 设置」或研究助手「模型设置」可管理至多 20 组配置；普通问答与正文 `/` 卡片共用「回答模型」选择。预览客户端按 namespace 将非秘密元数据存入浏览器，密钥输入与连接测试禁用；即使选择了云服务配置也只返回演示资料检索，不调用真实模型。正式客户端使用门户 `/api/v1/solutions/ai/settings` 与 `/api/v1/solutions/ai/test`，独立于 PM 全局设置，需稳定的 `APP_SECRET` 和新增 `007` 数据表。接口、默认选择及自托管边界见[个人模型配置](knowledge-solutions.md#个人模型配置)。

本轮个人多模型已完成本地预览验证：前端 27 个文件、358 项测试、TypeScript 与 Vite 构建、8 个相关 TypeScript / TSX 文件 ESLint 和差异检查通过；后端相关 243 项回归通过，其中新增 141 项，使用隔离 SQLite、IAM 替身和模拟网络。Ruff、迁移重复升级和表结构校验通过。浏览器已保存四类云服务的非秘密示例配置，并确认默认配置显示于助手选择、刷新后四组配置保留；约 675 / 400 像素宽屏的设置弹窗无横向溢出，可纵向滚动，预览密钥与测试按钮均禁用。占位模型 ID 未用于真实调用。未读取生产密钥、未调用真实模型、未推送或部署。可在 `backend` 执行 `python -m pytest tests/test_solution_ai.py tests/test_solution_ai_transport.py tests/test_solutions.py tests/test_solution_knowledge.py tests/test_ai.py -q` 复验；既有 `test_real_http_transports_and_connection_check` 需要允许在 `127.0.0.1` 随机端口启动本地模拟 HTTP 服务，不调用外部供应商。下列 318 项等验证记录属于之前的独立迭代。

本轮压缩报告标题与项目区域，并在顶部提供「返回应用平台」链接。开发预览应返回 `/?preview=1`，正式模式返回 `/`。「专注模式」开关移入报告撰写模块：分栏时在模块标题栏，专注时在模块工具栏；首次仍默认分栏，关闭开关恢复之前排列。模式切换保留原知识库 iframe、问答卡片、正文文字撤销记录和配方状态。

本轮本地验证完成：24 个前端测试文件、318 项测试、TypeScript 与 Vite 构建、`SolutionsApp` 和 `SolutionsFocusWriting` 两个相关文件 ESLint 及差异检查通过。真实浏览器确认返回平台保留 `/?preview=1` 并可重新进入；1280 × 900 下摘要高 48 像素、工作区顶部 104 像素，开关仅在当前报告撰写模块内可见，正文与原布局保留。专注工具栏与辅助面板边界对齐；约 400 像素宽时工具栏换为约 74 像素高的两行，正文无重叠、页面无横向溢出，约 675 像素宽也已核对。此前 316 项测试保持独立历史，详见 CHANGELOG。仅本地预览，未推送或部署。

本轮正文内问答与目录显隐已完成本地预览验证，未推送或部署。交互核对入口为可编辑章节正文：输入 `/`，选择「AI 问答」，在行内临时卡片提问，核对答案后明确采纳；目录通过显式的隐藏和展开入口切换。卡片位置只保留本次打开报告，完成回答仍由现有问答历史保存，演示与正式数据相互隔离。

本轮本地验证结果：全部前端 22 个测试文件、298 项测试通过，TypeScript 检查与 Vite 构建通过，6 个相关 TypeScript / TSX 文件的 ESLint 及差异格式检查通过；浏览器已核对键盘操作、插卡和提问。针对性集成回归确认同位置卡片按所在段顺序插入、撤销按本次采纳范围定位，以及切换报告失败后卡片可重试。真实账号权限、企业来源改版与撤权、模型服务仍需在目标环境验收；本地测试不替代生产验收。

针对性检查：`npx vitest run src/features/solutions src/pages/Workspace.test.tsx`、`node scripts/test-portal-routing.mjs`；后端在 `backend` 执行 `python -m pytest tests/test_solutions.py tests/test_solution_knowledge.py -q`。Node 26 的实验性 Web Storage 会干扰 jsdom，建议使用与 CI 一致的 Node 20 或稳定的 Node 24。

## CI 与验收范围

GitHub Actions 检查前端账号权限覆盖率、门户路由及构建、后端格式、PostgreSQL 测试及账号接口覆盖率、Docker 镜像构建；ESLint / Ruff lint 目前仅报告问题。
工作流配置见 [CI](../.github/workflows/ci.yml)。CI 使用 PostgreSQL 16，客户部署配置使用 18，升级前须关注版本差异。
自动测试通过不能代替真实用户换码、跨应用 SSO、业务权限及生产升级验收，具体步骤见部署交接。

## 独立笔记本地验证（2026-10-25）

本轮门户前端 42 个测试文件 482 项通过，TypeScript、相关 ESLint、门户路由脚本和构建通过。后端 `test_notes`、`test_portal`、`test_solutions`、`test_solution_conversations`、`test_solution_ai`、`test_solution_ai_transport`、`test_solution_polish` 共 248 项通过；新增笔记代码与迁移 Ruff 检查通过。知识库嵌入视图、顶部导航和旧笔记流程 18 项通过，类型、相关 lint 及构建通过。既有浏览器兼容数据/构建包体积提示与后端弃用警告仍存在，不影响本轮功能检查。

浏览器已核对独立笔记新建、刷新保留、研究报告选区三按钮、摘录来源及行业信息共享笔记；研究报告默认先进入主页。可从本地 `/notes?preview=1`、`/solutions?preview=1`、`/information/notes?preview=1` 查看。预览数据在本机独立保存，不读取生产 IAM、KB 或调用模型。009 迁移仅在隔离库验证，未推送、未迁移或部署生产，真实账号和跨设备访问仍需目标环境验收。

2026-10-25 笔记界面统一：前端 42 文件 483 项测试通过，TypeScript、4 个变更 TS/TSX 文件的 ESLint 和 Vite 构建通过。新增应用导航回归覆盖来源切换、重复点击当前分类及回收站返回；既有选区摘录、编辑冲突、保存失败和行业信息复用测试保持通过。浏览器已核对 1267×713 桌面侧栏、678×923 顶部分类及编辑窗口，正文来源和底部保存区可见、无横向溢出。此轮只改前端界面与布局，没有新增 API、环境变量或数据库迁移，未推送或部署。

## AI 助手本地验证（2026-10-25）

工作台新增最前面的 AI 智能版块，入口 `/assistant?preview=1`。当前前端45文件500项全量测试通过；新增客户端/组件/路由覆盖独立身份、请求重试、版本冲突、草稿保留、异步结果归属、模型显式选择、任务分类与门户准入。TypeScript、相关TS/TSX的ESLint、门户路由脚本和Vite构建通过。后端32项新助手测试及相关笔记、门户、个人模型和报告回归共280项通过，新增文件Ruff检查与格式检查通过；模型及IAM均使用测试替身。

浏览器核对了工作台顺序、1267×713三栏界面、新建任务及项目分组、显式附带资料、提问与独立产物、概览、结果区放大/收起，以及678×923的任务/结果抽屉和导出按钮可见性；没有横向溢出。Vite既有包体积及Browserslist更新提示仍存在。010迁移仅在隔离SQLite中验证，未推送、未访问或迁移生产，也未调用真实模型。真实IAM账号、模型费用与生产升级仍需目标环境验收。

## 行业信息界面本地验证（2026-10-26）

行业信息针对性 5 文件 54 项、全量前端 45 文件 501 项测试通过，TypeScript、2 个相关 TSX 文件 ESLint、Vite 构建与差异格式检查通过。新增回归覆盖来源弹窗初始焦点、连续键盘编辑、Escape 关闭与焦点返回；既有收录、资料、笔记与选区流程保持通过。版本更新源已生成 52 条记录。

浏览器核对 1267×713 的深蓝顶栏、侧栏、来源卡片、概览、批量收录与运行页，资料列表/阅读区及来源弹窗；678×923 下横向导航、两列来源范围、上下资料阅读布局可用且无横向溢出。截图留存在本地 `docs/知识方案应用/` 的 `行业信息统一风格*_20261026.png`。既有 Browserslist 与构建包体积提示仍存在；仅改前端外观和弹窗焦点，没有后端改动、迁移或真实采集验证，未推送或部署生产。

个人助手移除项目功能的回归检查：`npm test -- src/features/assistant src/pages/Assistant.test.tsx`；后端在 `backend` 执行 `pytest tests/test_assistant.py tests/test_assistant_diagnostics.py tests/test_assistant_knowledge_tools.py`。覆盖旧分组任务继续使用、仅按任务名称搜索、旧数据源选项忽略、接口拒绝项目数据源，并保留回收站和诊断功能。旧浏览器任务及对话不清空；本次无需数据库迁移。

助手的分轮对话展示回归检查包含在 `npm test -- src/features/assistant src/pages/Assistant.test.tsx` 中，覆盖问题与回答归属、轮次之间内容隔离、对应回答的复制/产物操作，以及未匹配历史消息保留。界面验收需核对连续两轮长回答、窄屏和深色主题的边界与横向溢出。
