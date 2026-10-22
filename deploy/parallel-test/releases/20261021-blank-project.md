# 空白项目创建 · 生产上线记录

2026-10-21 23:47（America/New_York，UTC−4）完成切换。新建项目第 2 步提供独立的「空白项目」选项，不需要模板；第 3 步确认并填写预算，保存为 0 个子项目、0 个任务、0 个里程碑，之后通过「编辑项目」自行规划。

## 交付与版本

| 项目 | 实际值 |
|---|---|
| 功能 PR | [#29](https://github.com/OpenLimsAI/mb-pm/pull/29)，5 项 CI 全部通过后 squash merge |
| 固定构建源码 | `main` 提交 `ed200a815a5bab1bf8851b9c2ba5baeaf53152bf` |
| main CI | [39717646691](https://github.com/OpenLimsAI/mb-pm/actions/runs/39717646691)，成功 |
| 生产镜像 | `mb-pm:blank-project-20261022T034226Z`（标签使用 UTC） |
| 镜像 ID | `sha256:6ab23da25acdd2513b9460839d68cb674b8b340224971dff953b0304a6355e19` |
| 回滚镜像 | `mb-pm:roles-20261018T231318Z` |
| 源码快照 | `/home/prometheus/mb-pm-v2/releases/blank-project-20261022T034226Z/`，237 个已跟踪源码文件及 `source-state.json` |
| 发布包 SHA256 | `1ca3fdcebc8b3e88ebe4f6b63a8f31f72aecbf2a81f6d8e75578720eb468f190` |
| 正式入口资源 | `/assets/index-C155RosO.js` |
| 项目创建分包 | `/assets/ProjectCreate-L95-5PT7.js` |
| 切换检查窗口 | 2026-10-22T03:47:25.356361Z 至 03:47:51.946585Z，约 27 秒；不是逐请求测得的停机时间 |

## 构建、备份与变更范围

- 发布包从上述 Git 提交导出，只包含构建输入，不包含本地环境文件、私钥、数据库或未跟踪文件；服务器逐文件复核清单与归档哈希。
- 现网 71 个后端文件与 main 构建输入逐字节一致，运行依赖归一化换行后也一致。本次复用原运行镜像，仅替换 `/code/static`；没有数据库迁移。
- 前端使用 Docker 内置构建前端执行原构建指令，派生 Dockerfile 仅去除可选的 `# syntax=` 指令，过程保存在 `Dockerfile.frontend-build`、`Dockerfile.frontend-update` 及构建日志中。
- 仅重建 `app` 与 `app-direct`；其他 11 个容器 ID 和镜像未变，包括 IAM、数据库、Cloudflare 隧道及知识库。
- `.env` 仅变更 `PMS_IMAGE_TAG`。其余配置文件、两个应用的运行环境、持久卷挂载及 AI 设置均与发布前一致。

备份目录为 `/home/prometheus/mb-pm-v2/private-config-backups/blank-project-20261022T034226Z/`（目录 700，私密文件 600），仅保留在服务器：

- 切换前的 PM / IAM 数据库 dump，均通过 `pg_restore -l` 验证。
- 原 `.env`、Compose、`app.conf`、直连 Caddyfile、AI 设置及前一镜像。
- `prepare.json`、`candidate-checks.json`、`deployment-receipt.json`、`runtime-checks.json`、`public-checks.json`。
- `data-before-switch.json`、`data-after-switch.json`：业务表行数及归一化哈希，不含原始业务记录。

## 验证结果与范围

| 范围 | 结果 |
|---|---|
| 功能验证 | 本地前端 46 项、相关后端 21 项通过；GitHub CI 的 PostgreSQL 全量测试及所有检查通过 |
| 隔离镜像检查 | 无网络、无生产凭据的短生命周期容器核对入口、创建分包、空白项目文案和后端未变 |
| 正式服务 | 两个应用均 healthy，启动日志无错误指标，直连入口检查通过 |
| 数据保留 | 13 张业务表切换前后行数与归一化哈希一致，含项目、任务、预算、成员、模板及 AI 分析记录 |
| 公网 | 11 项检查通过：PM 健康、门户页面、创建页面、匿名鉴权、IAM / KB 入口及资源哈希 |
| 缓存与资源 | PM / 门户入口和项目创建分包与镜像 SHA256 一致；页面 `no-cache`，带哈希资源长期缓存 |
| 知识库 | 匿名根请求返回 401 / `unauthenticated` / `sign in required`，容器 healthy；这只是服务与认证拦截检查，不代表真实登录验收 |
| 生产浏览器 | 品牌登录页可用；当前没有生产登录会话，因此未进入登录后的创建向导，也未创建生产测试项目 |

**真实客户操作待验收：** 系统管理员或项目负责人登录后，进入「创建项目 → 创建方式 → 空白项目」，确认预算后创建真实项目，检查任务数为 0，再通过「编辑项目」添加结构。当前发布不宣称已完成这一步。旧页面仍打开时先刷新。

## 回滚

在 `/home/prometheus/mb-pm-v2` 将 `.env` 中的 `PMS_IMAGE_TAG` 改回 `roles-20261018T231318Z`，只执行：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
curl -fsS http://127.0.0.1:18082/health
python3 direct_entry.py check
```

切换脚本在健康、配置或数据检查失败时自动恢复原镜像；本次未触发回滚。原镜像和备份保留，不回退数据库、不覆盖整份 `.env`，不修改 DNS、隧道或 IAM 配置。

发布记录的后续文档 PR 不触发额外生产部署；实际运行源码仍固定为本页记录的功能合并提交。
