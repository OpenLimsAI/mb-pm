# 任务视角与项目 WBS 排序统一 · 生产上线记录

2026-10-22 01:43（America/New_York，UTC−4）完成切换。任务视角按照项目列表顺序、子项目手动顺序、子项目内任务的 WBS 顺序连续显示；筛选后保留该顺序，不再沿用 API 的跨项目计划开始日期排序。

## 交付与版本

| 项目 | 实际值 |
|---|---|
| 功能 PR | [#31](https://github.com/OpenLimsAI/mb-pm/pull/31)，5 项 CI 全部通过后 squash merge |
| 固定构建源码 | `main` 提交 `8cd9c97750af042eaa39757bd3c4da3cecae6e65` |
| PR CI | [39728903512](https://github.com/OpenLimsAI/mb-pm/actions/runs/39728903512)，5 项检查成功 |
| main CI | [39729103515](https://github.com/OpenLimsAI/mb-pm/actions/runs/39729103515)，成功 |
| 生产镜像 | `mb-pm:tasks-wbs-order-20261022T053905Z`（标签使用 UTC） |
| 镜像 ID | `sha256:dd854cfcd4a7a0d721f3043b618eacb404cca24f6ff34dadbd591e3439c162a2` |
| 回滚镜像 | `mb-pm:blank-project-20261022T034226Z` |
| 源码快照 | `/home/prometheus/mb-pm-v2/releases/tasks-wbs-order-20261022T053905Z/`，239 个已跟踪源码文件及 `source-state.json` |
| 发布包 SHA256 | `bc0cdc89ae448bc16c3b038be7bbd486160a36f4d38b78ca9830ad954cb9fdf6` |
| 正式入口 / 任务分包 | `/assets/index-BOhM262n.js` / `/assets/Tasks-Cooc5OMX.js` |
| 切换检查窗口 | 2026-10-22T05:42:56.729935Z 至 05:43:23.321468Z，约 27 秒；不是逐请求测得的停机时间 |

## 行为与变更范围

- 项目顺序使用现有项目列表顺序；子项目使用 `sortOrder`，相同序号保留原有列表顺序。
- 同一子项目内复用 WBS 的 `byWbsOrder`：手动序号优先；没有序号的旧任务排在后面，以计划开始日期及编号确定先后。
- 在权限筛选后排序，不扩大可见范围；项目、关键字等筛选维持相对顺序，结构顺序刷新后重新排列。不修改后端接口、任务内容、持久化顺序号或数据库结构。
- 发布包从上述 Git 提交导出构建输入，不含本地环境文件、私钥、数据库及未跟踪文件；服务器复核归档与逐文件哈希。
- 71 个后端文件及运行依赖与现网一致，沿用原运行镜像，仅替换 `/code/static`。前端构建保持原指令，派生 Dockerfile 仅去除可选 `# syntax=`，避免额外拉取 Dockerfile 前端镜像。
- 仅重建 `app` / `app-direct`，其余 11 个容器 ID 与镜像未变，包括知识库、IAM、数据库及 Cloudflare 隧道。
- `.env` 仅更改 `PMS_IMAGE_TAG`；其他配置、环境变量、挂载及 AI 设置均与切换前一致。

## 备份与验证

备份目录：`/home/prometheus/mb-pm-v2/private-config-backups/tasks-wbs-order-20261022T053905Z/`。目录权限 700、文件权限 600，敏感内容仅留服务器：

- 切换前 PM / IAM 数据库 dump 均通过 `pg_restore -l`；原 `.env`、Compose、`app.conf`、直连 Caddyfile、AI 设置及前一镜像保留。
- `prepare.json`、`candidate-checks.json`、`deployment-receipt.json`、`runtime-checks.json`、`public-checks.json` 记录准备、镜像、服务和公网结果。
- `data-before-switch.json` / `data-after-switch.json` 保存业务表行数和归一化哈希，不含原始业务记录。

| 范围 | 已验证结果 |
|---|---|
| 排序回归 | 新增 8 项测试通过，覆盖跨项目分组、子项目顺序、手动任务顺序、日期兜底、筛选、个人权限及顺序刷新 |
| 本地与 CI | 完整前端 54 项通过，覆盖率门槛不变，构建及修改文件 lint 通过；PR 全部 CI 成功，包含 PostgreSQL 全量测试及镜像构建 |
| 本地界面 | 演示数据 99 条任务连续显示为 MAB-201、MAB-202、MAB-203 三组，各 33 条，控制台无错误；不是客户生产数据验收 |
| 隔离镜像 | 无网络、无生产凭据的短生命周期容器核对入口、任务分包、排序文案及后端未变 |
| 正式服务 | 两个应用均 healthy，启动日志错误指标为 0，直连检查通过，AI 设置字节哈希与服务器备份一致 |
| 业务数据 | 项目、子项目、任务、依赖、预算、成员、账号绑定、模板及 AI 分析等 13 张业务表切换前后行数与哈希一致 |
| 公网 | 11 项通过：PM 健康、门户页面、任务路由、匿名鉴权、IAM / KB 入口及资源哈希；页面 `no-cache`，带哈希资源长期缓存 |
| 知识库 | 容器 healthy，匿名根请求按预期返回 401 / `unauthenticated` / `sign in required`；未进行知识库业务操作 |
| 生产浏览器 | 任务路由正常进入品牌登录页；当前无生产会话，尚未核对真实账号登录后的客户任务列表 |

**真实账号验收待完成：** 刷新并登录生产「任务」页面，筛选 `CMAB-PRJ-2026-0002`，核对「项目启动」中的「召开项目启动会」位于「供应商考察」中的「供应商考察、选定」之前，再与项目 WBS 对照其余顺序。本次未创建或修改生产测试数据，也不宣称完成了这一步。

## 回滚

在 `/home/prometheus/mb-pm-v2` 将 `.env` 中 `PMS_IMAGE_TAG` 改回 `blank-project-20261022T034226Z`，只执行：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
curl -fsS http://127.0.0.1:18082/health
python3 direct_entry.py check
```

切换脚本在健康、配置或数据检查失败时恢复原镜像；本次未触发回滚。原镜像和备份保留，不回退数据库、不覆盖整份 `.env`，不修改 DNS、隧道、IAM 或知识库。

本记录及交接文档的后续文档 PR 不触发额外生产部署；实际运行源码固定为本页记录的功能合并提交。
