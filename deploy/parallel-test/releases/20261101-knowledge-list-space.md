# 知识源论文列表留白修复（2026-11-01，America/New_York）

桌面论文列表原有独立高度上限，详情面板较长时会在列表下方留下空白。列表现在填满共用网格行，继续独立滚动和固定表头；详情开关和窄屏布局保留。

## 固定源码与发布状态

- 按 PR → 最新提交全部 CI 成功 → squash merge 执行。首次将本记录合入 main 的 squash 提交为固定源码，不从功能分支构建生产。
- 本次为 CSS 与文档修复。构建前核对后端、依赖和迁移与当前生产一致，只替换静态文件。
- 目标镜像 `mb-pm:knowledge-list-space-20261101`。精确源码、tree、镜像 ID、包摘要及实际部署状态，以服务器 `/home/prometheus/mb-pm-v2/releases/knowledge-list-space-20261101/{image,verification,operations}.json` 为准；成功回执出现前不预称上线。
- 发布前基线为 `99ca39d8038dd3fe2a0d0b24247d682f0c186a1f` / `mb-pm:deepseek-search-99ca39d-20261101`，镜像 ID `sha256:81aa41478b2c6a4a45d3bd855c5700d348e4cddc6bb1a48b0caa68bf1c03ed07`；main 的 `5b320bf` 为该次发布文档补充。

## 配置、验证和回滚

运行必须保留完整七份 Compose，继续保留 DeepSeek 搜索、私有知识库连接、知识源手动 worker 及已关闭的旧行业信息 / 笔记同步 worker：

1. `compose.yml`
2. `compose.production.yml`
3. `compose.direct.yml`
4. `releases/header-9516977/compose.no-note-sync.yml`
5. `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`
6. `releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`
7. `releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`

本次目录 `compose-production.sh` 为保留完整组合的运维入口。只更新 app / app-direct；不改 KB 镜像、模型设置、既有会话和业务记录，不新增迁移。候选使用生产备份的隔离数据库与原件 / 模型副本，禁用采集 worker，不执行新的搜索、下载或模型请求。验证现有论文、原件摘要、NEW 数据类型、既有消息和配置；本地布局验收使用明确的样例数据，不冒充生产真实账号交互。

私有备份和失败 / 成功回执留在服务器 `private-config-backups/knowledge-list-space-20261101/`，不提交仓库。切换前重新检查活动任务和实际运行基线；生产恢复原镜像只切两个 PM 镜像，继续使用全部七份配置，保留现有数据库、原文和模型配置，不恢复旧业务库或执行 downgrade。回滚目标为上述 DeepSeek 搜索镜像，回滚是否实际执行以回执为准。

源站与回环反代的资源摘要、健康、匿名鉴权检查与公网真实浏览器流程分别记录。公网探测的网络 / Cloudflare 限制不通过修改边缘安全配置处理。
