# 高效工作台 UI 发布（2026-11-03，UTC）

门户与项目管理的「高效工作台 · 极光青」界面已切换到两个正式 PM 实例。本次只替换前端静态文件，沿用线上研究报告工作台后端；生产内部检查及源站匿名登录页视觉检查通过，公网真实账号登录仍待补。

## 版本与范围

| 项目 | 固定版本 |
|---|---|
| UI 代码 | [PR #132](https://github.com/OpenLimsAI/mb-pm/pull/132)，squash main `c6e4b9fc7ec8187dce2e952eda0c9c32fd5aad55` |
| 保留的后端 | `e33b48d62494a1ab064a796b3269c0efd1623c71`，见[研究报告工作台发布记录](20261102-research-report-workbench.md) |
| 本次生产镜像 | `sha256:79e46c9cd698583f91a1a12447f941eb5337640c644067a8daf6e16ff6cd7b7e` |
| 切换前及回滚镜像 | `sha256:8a7080dd4492336f5934b099b826b87ceb28767165e19e71f929203bf1aab292` |
| 更新服务 | `mb-pm-v2-app-1`、`mb-pm-v2-app-direct-1` |

正式入口为 [员工门户](https://www.openlims.ai/) 和 [项目管理](https://pm.openlims.ai/)。统一浅灰侧栏、白色 56px 顶栏、极光青主色与紧凑控件；项目工作台默认列表和详情联动，保留卡片、表格、矩阵与完整项目入口；首页收紧 KPI，将风险信息提前。门户、助手、报告、笔记和知识源采用相同基础样式。功能说明见[高效工作台](../../../docs/efficient-workspace.md)。

镜像以切换前的固定镜像为基础，只更新 `/code/static`。已校验旧镜像完整层链、`/code/app`、`/code/alembic`、`requirements.lock` 和 `alembic.ini` 与候选一致。前端版本标识为 `c6e4b9f`，不代表后端同时更新到该提交，也未发布后来 main 的 OIDC / 身份会话改动。本记录仅覆盖上述两实例；其他应用的独立发布须以各自回执为准。

## 验证结果与边界

- PR 最新提交的 7 项 CI 全部通过后合并。合并提交的 main CI 被后来 main 提交取消，重跑也被取消，不能记为 main CI 全部通过；固定 main 的 368 个前端源文件与获批 PR 一致。
- 固定源码生产构建通过，最终镜像离线 Trivy 扫描、静态清单逐文件哈希核对和 Chrome 匿名登录输入检查通过。真实 API 为 `/api/v1`，`useApi=true`，模式为 `domain`。
- 正式切换退出码为 0，两实例均 healthy，逐文件静态清单匹配 `c6e4b9f`；运行 UID 为 10001，数据库角色仍为 `maibo_pm_runtime`，没有管理、建库、建角色、绕过 RLS 或 public schema 建表权限。
- 业务检查约束计数保留：`projects=4`、`sub_projects=2`、`tasks=7`、`project_finances=1`。两个实例各自只读连接 Core 并读取 280 份资料；健康响应具有 CSP，任务、助手任务与笔记接口匿名均为 401，持久数据目录和模型设置可读。
- 曾使用默认 User-Agent、正常 TLS 校验的标准 `curl` 取得 `https://www.openlims.ai/health` HTTP 200，响应为生产健康状态。当前环境后续公网复验不稳定：两域 `/health`、`/login`、`/build-info.json`、`/api/v1/portal/me` 的批量 curl 遇到连接重置或超时，Python urllib 探针则返回边缘层 403。因此公网版本及匿名鉴权未完整验收，不能把 403 当作应用预期的 401，也不能推断公网全部不可达或全部通过。
- 经既有 SSH 运维转发只读访问真实生产源站，匿名登录页 DOM 与截图检查通过，无浏览器报错，用户名、密码和登录按钮正常。这是源站运维通道视觉验收；直接公网浏览器读取曾超时，公网真实账号登录仍待补。未代客户执行业务写入或付费模型请求。

本次没有数据库迁移、种子导入、账号 / 密码 / 角色调整或业务数据恢复。现有报告工作台与安全基线继续运行。

## 配置、备份与切换

从两实例实际容器标签读取并保留完整十份 Compose，顺序如下；路径均为服务器现有文件，不在仓库复制私有配置内容：

1. `/home/prometheus/mb-pm-v2/compose.yml`
2. `/home/prometheus/mb-pm-v2/compose.production.yml`
3. `/home/prometheus/mb-pm-v2/compose.direct.yml`
4. `/home/prometheus/mb-pm-v2/releases/header-9516977/compose.no-note-sync.yml`
5. `/home/prometheus/mb-pm-v2/releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`
6. `/home/prometheus/mb-pm-v2/releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`
7. `/home/prometheus/mb-pm-v2/releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`
8. `/home/prometheus/security-hardening-20261102/limits-1.json`
9. `/home/prometheus/security-hardening-20261102/pm-release-cd02021/compose.security.active.yml`
10. `/home/prometheus/mb-pm-v2/releases/report-workbench-e33b48d-20261102/compose.report-workbench.yml`

仅在最后追加本次发布目录的 `rollout/pm.fixed-images.json`，因此切换后使用十一份 Compose。解析后的完整配置只允许 `app.image`、`app-direct.image` 两处变化，启动命令为 `up -d --no-deps --wait --wait-timeout 120 app app-direct`。后续运维继续使用容器标签记录的完整文件序列，不能退回只读基础 Compose。

发布前核对 Compose 与 live 容器的启动命令、用户、安全限制、资源上限、日志、网络、卷和端口；切换后再次检查运行安全属性、环境变量、挂载及网络。发布与每日备份、独立备份、安全维护共用非阻塞锁；备份前及实际切换前分别确认没有 queued / running 的知识源任务或助手请求。这是切换时检查，不表示长期关闭新任务准入。

- 发布根目录：`/home/prometheus/mb-pm-v2/releases/efficient-workspace-c6e4b9f-20261103`。
- 成功回执：发布目录下 `rollout/result.json`，记录两实例验证和原十份 Compose；`rollout/activity-switch.json` 记录切换前任务检查。
- 私有备份：发布目录下 `rollout/private-backup/`，保存原 Compose、`.env`、运行状态及校验摘要；目录 0700、文件 0600，内容不进入 Git。
- 数据库备份：`rollout/private-backup/pm-before.dump.gpg`，使用服务器既有私有密钥以 AES256 加密，并完成解密校验；数据库和密钥未下载到开发电脑。

## 回滚

发布目录下 `rollout/rollback-command.json` 保存完整回滚命令，使用原十份 Compose 加 `rollout/pm.rollback-images.json`，将两个 PM 服务恢复到 `sha256:8a7080dd4492336f5934b099b826b87ceb28767165e19e71f929203bf1aab292`。发布脚本在启动、健康或后置检查失败时执行此命令，并再次验证旧镜像和运行属性。

回滚只切换镜像，保留现有数据库、019 台账、模型配置及发布后的业务写入；不执行 downgrade，也不把发布前备份直接覆盖到生产数据库。回滚后仍需复验健康、匿名鉴权、静态清单和真实登录。此次文档补充不触发重新构建或部署。
