# 研究报告编辑区布局修复发布（2026-11-03，UTC）

研究报告编辑区布局修复已部署到两个正式 PM 实例。本次只替换前端静态文件，保留当前 SSO 后端、业务数据与完整生产配置；两实例内部检查通过，公网版本已确认，真实账号与本次生产编辑器视觉验收仍待补。

## 版本与范围

| 项目 | 固定版本 |
|---|---|
| 修复代码 | [PR #137](https://github.com/OpenLimsAI/mb-pm/pull/137)，获批 head `3360a794383a9824bd027a3e950d15f90522c703` |
| 固定前端构建提交 | squash main `48401af77629441d2b5eaf08eb75d71984a58285` |
| 保留的当前后端 | `e0b6f85f25c67851e500fa896b4520c59c11d082` |
| 本次生产镜像 | `sha256:228645c4c29a3469bba6ae9ae2df42c345e2a5bf25a8bd9f1879ce0fc3c13a00` |
| 切换前及回滚镜像 | `sha256:51b3dc7af62920df4030f828ffe657940f326dfe91f4f94824c4353ec2a94a4e` |
| 更新服务 | `mb-pm-v2-app-1`、`mb-pm-v2-app-direct-1` |

正式入口为 [员工门户](https://www.openlims.ai/) 和 [项目管理](https://pm.openlims.ai/)。修复范围为研究报告编辑器：内容区沿 flex 容器填充可用空间，AI 卡片间的文本片段采用紧凑高度，只有最后一段扩展；移除 contenteditable 聚焦时多余的外框，并保留工具栏焦点反馈；统一可视 / Markdown 按钮的尺寸、选中与交互状态；空内容提示以编辑器真实空状态判断，仅在可编辑时显示。功能说明见[研究报告工作台](../../../docs/research-report-workbench.md)。

镜像以切换前的固定镜像 `51b3dc7` 为基础，只更新 `/code/static`；旧镜像完整层链及 `/code/app`、`/code/alembic`、`requirements.lock`、`alembic.ini` 一致性检查通过。当前镜像已包含 `e0b6f85` 的 SSO 变更，本次保留其后端与前端功能。固定前端版本 `48401af` 不代表后端同时更新到该提交。本记录仅覆盖上述两实例。

## 验证结果与边界

- PR #137 最新 head `3360a794383a9824bd027a3e950d15f90522c703` 的全部 7 项 CI 成功后 squash 合并。从固定合并提交获取的 GitHub 源码归档，其 785 个 tracked 文件与获批 PR 逐字节相同。
- 固定源码生产构建通过，产物包含 173 个静态文件；真实 API 为 `/api/v1`，`useApi=true`，应用模式为 `domain`。候选预检确认完整十二份 Compose 保留，解析后的配置只有两个应用镜像变化。
- 最终镜像离线 Trivy 扫描通过，扫描证据绑定候选 OCI manifest、全部 layers 和 config；可修复 HIGH / CRITICAL 漏洞计数为 0。扫描时禁用网络，漏洞数据库更新时间为 `2026-11-02T19:15:11Z`，结论以该数据库和上述严重度 / 可修复范围为限。
- 正式切换退出码为 0，两实例均 healthy，173 个静态文件逐文件匹配清单及 `48401af`。运行 UID 为 10001，数据库角色仍为 `maibo_pm_runtime`，没有管理、建库、建角色、绕过 RLS、public schema 建表权限或额外角色成员资格；安全限制、环境变量、挂载和网络保留。
- 业务检查约束计数保留：`projects=4`、`sub_projects=2`、`tasks=7`、`project_finances=1`。两个实例分别只读连接 Core 并读取 280 份资料；健康响应具有 CSP，任务、助手任务与笔记接口匿名均为 401，持久数据目录和模型设置可读。
- 本次一轮标准 curl 公网检查中，`www.openlims.ai` 的 `/health`、`/login`、`/build-info.json` 均为 200，`/api/v1/portal/me` 为 401，四项命令均成功退出。`pm.openlims.ai` 的 `/build-info.json` 为 200、`/api/v1/portal/me` 为 401，均成功退出；两域静态版本均为 `48401af`，生产 API 参数正确。
- PM 公网 `/health` 收到 HTTP 200 和完整健康 JSON，但 curl 等待连接结束超过 15 秒，以 28 退出；`/login` 在 15 秒内未收到字节，同样超时。这两项未记为通过。真实账号及本次生产编辑器视觉 / 交互验收仍待补；此前匿名登录页视觉检查不计入本次验收。未重复公网探测或代用户执行业务写入、模型请求。

本次没有数据库迁移、种子导入、账号 / 密码 / 角色调整或业务数据恢复。代码、构建、运行状态与真实用户验收分别以上述证据为准。

## 配置、备份与切换

从两个实际容器标签读取并保留完整十二份 Compose，顺序如下；路径均为服务器现有文件，不在仓库复制私有配置内容：

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
11. `/home/prometheus/mb-pm-v2/releases/efficient-workspace-c6e4b9f-20261103/rollout/pm.fixed-images.json`
12. `/home/prometheus/mb-pm-v2/releases/knowledge-sso-20261102/application-switch/group-0.active.json`

只在最后追加本次发布目录的 `rollout/pm.fixed-images.json`，切换后容器标签确认使用十三份 Compose。完整配置只改变 `app.image`、`app-direct.image`，启动命令为 `up -d --no-deps --wait --wait-timeout 120 app app-direct`。后续运维继续使用容器标签记录的完整文件序列。

发布前核对 Compose 与 live 容器的启动命令、用户、安全限制、资源上限、日志、网络、卷和端口；切换后重新检查运行属性、环境变量、挂载与网络。发布实际持有每日备份 `.daily-backup.lock`、独立备份 `.backup.lock`、PM 发布及安全维护 / 发布锁，切换前再次核对容器 ID 和配置哈希。`activity-switch.json` 确认 queued / running 的知识源任务与助手请求均为 0；这是切换时检查，不表示长期关闭新任务准入。

- 发布根目录：`/home/prometheus/mb-pm-v2/releases/report-editor-layout-48401af-20261103`。
- 成功回执：发布目录下 `rollout/result.json`，记录两实例验证、镜像及原十二份 Compose；`rollout/activity-switch.json` 记录切换前任务检查。
- 私有备份：`rollout/private-backup/` 保存原 Compose、`.env`、运行状态及校验摘要，目录权限已确认 0700，内容不进入 Git。
- 数据库备份：`rollout/private-backup/pm-before.dump.gpg`，权限 0600、大小 2,237,519 字节；使用服务器既有私有密钥以 AES256 加密，并解密至 `/dev/null` 完成校验。数据库与密钥未下载到开发电脑。

## 回滚

`rollout/rollback-command.json` 已落盘并确认权限为 0600，使用完整原十二份 Compose 加 `rollout/pm.rollback-images.json`，将两个 PM 服务恢复到 `sha256:51b3dc7af62920df4030f828ffe657940f326dfe91f4f94824c4353ec2a94a4e`。发布脚本在启动、健康或后置检查失败时执行该命令，并再次验证旧镜像和运行属性；本次切换成功，未执行失败回滚。

回滚只切换镜像，保留现有数据库、模型配置和发布后的业务写入；不执行 downgrade，也不把发布前备份直接覆盖到生产数据库。回滚后仍需复验健康、匿名鉴权、静态清单和真实登录。此次发布文档补充不触发额外构建或部署。
