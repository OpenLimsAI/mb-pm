# 行业信息下线 · 生产发布记录（2026-11-01）

2026-11-01 09:29（America/New_York）完成上线核对。旧「行业信息」从工作台与个人应用访问清单移除，`/information/*`、`/launch/information` 显示下线说明。新「知识源」本轮只提供交互 UI，尚未接入或部署真实功能。

## 固定版本与检查

- [PR #104](https://github.com/OpenLimsAI/mb-pm/pull/104) 的五项 CI 全部通过后 squash，固定 main 源码 `2384eb85ac501c7cfd52e642f1e8ca9310b03215`。
- 并行 [PR #103](https://github.com/OpenLimsAI/mb-pm/pull/103) 只补充此前已部署登录连续性修复的两份文档；精确 Git blob 核对表明，发布源码的应用、依赖和配置与本次已验证 PR 一致。
- 镜像 `mb-pm:industry-off-2384eb8-20261101`，image ID `sha256:2332f0962215004a0591c4dd3281edeb7432f63315d754a4bebdfbf6a0341bfb`，OCI revision 为固定提交。
- 由固定源码在本机执行正式 API 前端构建；逐文件核对 Git blob。服务器验证运行依赖与现网逐字节一致后，基于现网镜像完整替换后端与静态文件。包 SHA-256 `917cb326dcfec5a5584384ac64b61def6a1b9361b3df5d3d7f60491f81bba27b`。
- 本地针对性前端 13 项、信息与门户后端 66 项、TypeScript、相关 ESLint、正式构建、路由与格式检查通过。保留全量 CI 的原覆盖率门槛。

## 下线与数据保护

`INFORMATION_APP_ENABLED=false` 在镜像中明确设置；即使旧 worker 环境开关仍为 true，信息采集线程也不启动，单步调度在访问数据库或网络前返回。登录后的旧管理接口返回 410。既有原文下载继续经过原门户会话、实时 IAM、租户与版本检查，避免破坏知识库既有原件链接。

生产两实例均健康，总开关 false、没有信息采集线程、门户 information 准入禁用；各自仍可读取 63 篇知识库论文。匿名信息 API 与原文下载为 401。登录续期和研究现场恢复、笔记跨域设置保持，笔记后台同步继续关闭。

38 张表记录数前后一致，既有业务及信息记录 ID 全部保留。354 条发现文档及相关目录、任务、偏好不迁移、不删除；现有 1 份 264104 字节原文在服务器另作备份，并逐文件核对 SHA-256 一致。其他 15 个容器及知识库镜像不变。没有写入测试论文或调用付费模型。

## 备份与回滚

服务器私有备份目录 `private-config-backups/industry-off-2384eb8-20261101/`，发布目录 `releases/industry-off-2384eb8-20261101/`。保存数据库归档、运行配置、原文包、前后元数据、候选检查及正式回执；私有数据未下载到本机或提交 Git。数据库备份 SHA-256 `31a610c4516b83ae3a47e8146dfb7e1410dead1f86fa1318a63b3dc289df96f5`。

部署保留全部五份 Compose：`compose.yml`、`compose.production.yml`、`compose.direct.yml`、`releases/header-9516977/compose.no-note-sync.yml`、`releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`。配置展开仅改变应用镜像；网络、卷、命令和已有连接环境核对一致。

回滚目标为 `mb-pm:session-continuity-e93056d-20261101`。确认当前版本后仅恢复 `PMS_IMAGE_TAG`，按同样五文件组合重建 `app` 与 `app-direct`；复查登录、知识库读取和服务健康。保留数据库、原文、文件夹及全部卷，不使用备份覆盖下线后的用户数据。

## 验收范围

候选先在独立数据库副本启动并验证。正式服务已核对开关、采集线程、应用目录、原文保留、匿名认证和知识库读取；没有借用客户浏览器身份执行操作。已授权原件读取的逻辑由隔离回归覆盖，真实员工登录后的页面体验仍可继续验收。公网读取结果另存服务器 `public-verification.json`，若受 Cloudflare 限制则不将其记为通过。
