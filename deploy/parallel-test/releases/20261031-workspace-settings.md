# 工作台管理入口归类 · 生产发布记录

发布时间：2026-10-31 22:38（America/New_York）。功能 [PR #81](https://github.com/OpenLimsAI/mb-pm/pull/81) 的五项 CI 全部通过并 squash 合并，发布源码固定为主分支提交 `c86bd6fa6af16b719e978824fb3e0838d8128115`。

## 范围与版本

- 主数据管理和账号管理移至「功能设置」，与我的设置、AI 设置同组；业务管理保留项目管理、回音壁和待开发的人力资源。
- 账号管理仍按 `accounts.enabled` 显示，主数据沿用 `mdm.enabled` 和受保护的 `/launch/mdm`，原权限及跳转保持有效。
- 运行镜像：`mb-pm:workspace-settings-c86bd6f-20261031`，镜像 ID `sha256:1b74979ec8b2d0a55cab7620c03bf37125008c641f4d4965dcf9ed3c6fdb0cf5`。
- Git HTTPS 传输失败后，改用 GitHub API 获取上述完整合并提交的源码归档；上传前核对工作台源码与已验证变更一致。白名单发布包 SHA-256 为 `1dc84d6d7d4d30596bdf4b0279f108a7bf0ccb7a44ed99db359fce7f8d99b96c`。
- 服务器按现有 Dockerfile 的前端阶段构建，仅去掉 syntax frontend 下载指令；随后以当前运行镜像为底替换 `/code/static`。新旧镜像的后端运行文件和依赖清单哈希一致，无数据库迁移。

## 配置与备份

继续使用线上实际的五文件组合：

1. `compose.yml`
2. `compose.production.yml`
3. `compose.direct.yml`
4. `releases/header-9516977/compose.no-note-sync.yml`
5. `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`

部署前后对照有效 Compose 配置，仅两个应用镜像字段变化。两个实例的环境变量与网络成员关系核对一致，`AUTO_SEED=false`、`NOTES_WISDOM_WORKER_ENABLED=false`，知识库私有连接覆盖保留。未展开或输出服务凭据。

备份保留在服务器 `/home/prometheus/mb-pm-v2/private-config-backups/workspace-settings-c86bd6f-20261031/`，包含原环境和 Compose 配置、容器元数据、AI 设置及数据库归档。数据库 `database.dump` 的 SHA-256 为 `e7ce8b07a9432900069b319df08d59089a1e792764542475fd755b0ad85bde4b`，已通过 `pg_restore --list` 可读性核对；此次没有重复进行完整数据库恢复演练。私有备份未下载到本机或写入 Git。

## 验证结果

- 仅重建 `mb-pm-v2-app-1` 和 `mb-pm-v2-app-direct-1`，两者 healthy；其他 15 个容器 ID 不变。
- 38 张表发布前后的记录数一致。
- 内部与直连 9 项检查通过，直连代理使用现有 Caddy CA 验证证书，没有关闭证书校验；两个实例的启动日志未发现 Traceback、FATAL、Uncaught 或 Unhandled 模式。
- 服务器自身访问公网时 TLS 握手超时，改从本机完成 8 项公网检查：门户登录页、工作台、门户/PM 健康接口均 200，匿名门户/PM 身份接口均 401。
- 工作台 HTML 因 Cloudflare 注入内容不能做整页字节相等判断；已确认它引用新脚本 `/assets/index-DOum_3mi.js`，www 与 pm 两个域名提供的该脚本 SHA-256 均与候选镜像一致。
- 两个实际应用实例的 Core 健康和论文目录检查通过，均读取到 63 篇有效论文；没有调用生成模型或改写论文。
- 卡片分组、准入与链接已通过功能 PR 的自动回归；此次没有使用真实员工账号完成浏览器点击验收。

服务器源码和回执位于 `/home/prometheus/mb-pm-v2/releases/workspace-settings-c86bd6f-20261031/`。部署回执为 `release-receipt.json`，内部验收为 `verification.json`，知识库核对为 `knowledge-verification.json`；公网核对另保留为 `public-verification.json`。

## 回滚

回滚镜像：`mb-pm:assistant-enter-508b438-20261031`，ID `sha256:b7999ad3a4bcc00fdcbc3562ee3ae6631de7c0576f4db4682a5ece5b1b523dda`；另保留同一镜像的本次回滚别名。

确认当前版本后，仅将服务器 `.env` 的 `PMS_IMAGE_TAG` 改回 `assistant-enter-508b438-20261031`，使用上述完整五文件组合重建 `app` 和 `app-direct`，依次等待 healthy，再核对健康、匿名鉴权与两个实例的知识库连接。保留所有现有运行配置和业务数据，不整份覆盖旧 `.env`，不回退数据库，不删除卷或重建其他服务。
