# 任务进展四状态与日期布局 · 生产上线记录

2026-10-22 03:33（America/New_York，UTC−4）完成切换。普通任务与里程碑的进展录入统一为「未开始、进行中、已完成、已验证」四个主状态；状态选择占整行，计划开始 / 结束同行，实际开始 / 结束同行。

## 交付与版本

| 项目 | 实际值 |
|---|---|
| 功能 PR | [#33](https://github.com/OpenLimsAI/mb-pm/pull/33)，5 项 CI 全部通过后 squash merge |
| 固定构建源码 | `main` 提交 `eaf31754000213dddfe02fc892e07749dfeb74d8` |
| PR CI / main CI | [39737112743](https://github.com/OpenLimsAI/mb-pm/actions/runs/39737112743) / [39737382006](https://github.com/OpenLimsAI/mb-pm/actions/runs/39737382006)，均成功 |
| 生产镜像 | `mb-pm:task-progress-20261022T070839Z`（标签使用 UTC） |
| 镜像 ID | `sha256:46696d655cc243baba2821414835a0cc0c0ad1b7b7e2c2e8621387b632e26952` |
| 回滚镜像 | `mb-pm:tasks-wbs-order-20261022T053905Z` |
| 源码快照 | `/home/prometheus/mb-pm-v2/releases/task-progress-20261022T070839Z/`，241 个已跟踪源码文件及 `source-state.json` |
| 发布包 SHA256 | `4cc3b2782a98064ce5db17d37077f53a469dd49e55363495b09a00f7366cc14b` |
| 正式入口 / 任务抽屉分包 | `/assets/index-maFKrGji.js` / `/assets/TaskDrawer-CfEXU87v.js` |
| 切换检查窗口 | 2026-10-22T07:33:19.764864Z 至 07:33:46.254386Z，约 27 秒；不是逐请求测得的停机时间 |

## 行为与变更范围

- 进展录入与状态流转共用四个主状态定义，去除里程碑仅能选择「未开始 / 已验证」的限制。
- 阻塞、延迟保留为已有存储状态，在主流程显示进行中，并单独显示副状态。仅修改日期不会清掉副状态，可显式清除副状态。
- 里程碑「标记完成」进入已完成，验证单独选择；完成 / 验证进度为 100%，退回未开始 / 进行中时为 0%，没有连续进度条。
- 普通任务与里程碑均将状态选择扩为整行，两组起止日期各占同一行，避免隐藏进度条造成字段错位。
- 从上述 main 固定提交导出构建输入并复核归档及逐文件哈希；不包含私钥、环境文件、数据库或用户未跟踪文件。
- 71 个后端文件与运行依赖均与现网一致，仅替换运行镜像内 `/code/static`；没有数据库迁移。前端使用相同构建指令，派生 Dockerfile 仅去除可选 `# syntax=` 指令。
- 仅重建 `app` / `app-direct`，其他 11 个容器 ID 和镜像未变，包括知识库、IAM、数据库及 Cloudflare 隧道。
- `.env` 仅更改 `PMS_IMAGE_TAG`；其余配置、两个应用的环境变量、挂载及 AI 设置与切换前一致。

## 备份与验证

备份目录：`/home/prometheus/mb-pm-v2/private-config-backups/task-progress-20261022T070839Z/`。目录权限 700，私密文件权限 600，敏感内容仅留在服务器：

- 切换前 PM / IAM 数据库 dump，均通过 `pg_restore -l`；原 `.env`、Compose、`app.conf`、直连 Caddyfile、AI 设置和前一镜像保留。
- `prepare.json`、`candidate-checks.json`、`deployment-receipt.json`、`runtime-checks.json`、`public-checks.json` 记录准备、镜像与上线检查。
- `data-before-switch.json` / `data-after-switch.json` 保存业务表行数和归一化哈希，不含原始业务记录。

| 范围 | 已验证结果 |
|---|---|
| 回归测试 | 新增 6 项通过：普通任务及里程碑四主状态、里程碑中间状态保存与完成快捷操作、副状态保留 / 显式清除、退回进行中时清除隐藏完成进度 |
| 本地与 CI | 完整前端 60 项通过，原覆盖率门槛不变，构建和修改文件 lint 通过；PR 及 main CI 成功，包含 PostgreSQL 全量测试与镜像构建 |
| 本地界面 | 普通任务及里程碑均显示四个主状态，状态栏宽 566px，日期每列 277px，计划和实际各自左右输入框的纵坐标一致；控制台无错误。这是本地演示界面验收 |
| 隔离镜像 | 无网络、无生产凭据的短生命周期容器核对新入口、任务抽屉分包、四主状态数组、加宽样式、日期和副状态文案及后端未变 |
| 正式服务 | 两个实例均 healthy，启动日志错误指标为 0，直连检查通过；AI 设置字节哈希与服务器备份一致 |
| 数据保留 | 项目、子项目、任务、依赖、预算、成员、账号绑定、模板、AI 分析等 13 张业务表切换前后行数与哈希一致 |
| 公网 | 11 项检查通过：PM 健康、门户页面、任务路由、匿名鉴权、IAM / KB 入口及新入口 / 抽屉资源哈希；页面 `no-cache`，带哈希资源长期缓存 |
| 知识库 | 容器 healthy；匿名根请求按预期返回 401 / `unauthenticated` / `sign in required`，未进行知识库业务操作 |
| 生产浏览器 | 任务入口正常进入品牌登录页；当前没有生产会话，未查看登录后的真实客户任务抽屉或保存生产任务 |

**真实账号验收待完成：** 刷新并登录项目管理，分别打开一个普通任务和里程碑，核对四个主状态、加宽状态栏及两组同行起止日期；在实际业务需要时保存状态并核对项目汇总。本次没有为验收创建或修改生产任务，不宣称真实账号保存验收已通过。

## 回滚

在 `/home/prometheus/mb-pm-v2` 将 `.env` 中 `PMS_IMAGE_TAG` 改回 `tasks-wbs-order-20261022T053905Z`，只执行：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
curl -fsS http://127.0.0.1:18082/health
python3 direct_entry.py check
```

切换脚本在健康、配置或数据检查失败时恢复原镜像，本次未触发回滚。保留原镜像和备份，不回退数据库、不覆盖整份 `.env`，不修改 DNS、隧道、IAM 或知识库。

本记录及交接文档的后续文档 PR 不触发额外生产部署，实际运行源码固定为本页的功能合并提交。
