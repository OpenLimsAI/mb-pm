# 知识源紧凑论文列表（2026-11-01，America/New_York）

收紧论文行和表头的上下间距、文档图标、标题与辅助信息之间的距离，以及文件夹 / 状态标签间距。标题和辅助信息字号不变，长标题保留完整换行；继续使用上一版填满列表高度的布局。

## 固定源码与发布状态

- 按 PR → 最新提交全部 CI 成功 → squash merge 执行。首次将本记录合入 main 的 squash 提交为固定源码，从该提交构建正式静态文件。
- 本次仅 CSS 与文档改动。构建前核对后端、依赖和迁移与当前生产一致，只替换静态文件。
- 目标镜像 `mb-pm:knowledge-compact-rows-20261101`。精确源码、tree、镜像 ID、包摘要及实际部署状态，以服务器 `/home/prometheus/mb-pm-v2/releases/knowledge-compact-rows-20261101/{image,verification,operations}.json` 为准；成功回执出现前不预称上线。
- 发布前基线 / 回滚目标为 `f162fd26ba727e48ef1e277dfc9177bfca2b02e6` / `mb-pm:knowledge-list-space-20261101`，镜像 ID `sha256:0fdefe15804d6ea25faaa40587609c4b936f0983b785950bd722311370efaa47`。

## 配置、验证和回滚

继续使用完整七份 Compose，保留 DeepSeek 搜索、私有知识库连接和知识源手动任务配置：

1. `compose.yml`
2. `compose.production.yml`
3. `compose.direct.yml`
4. `releases/header-9516977/compose.no-note-sync.yml`
5. `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`
6. `releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`
7. `releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`

本次目录 `compose-production.sh` 保留完整组合，仅更新 app / app-direct，不改 KB、模型设置或既有业务记录，不新增迁移。先以生产备份建立隔离数据库、原件和模型副本，禁用采集 worker；验证现有论文、原件摘要、NEW 数据类型、消息及配置，不执行新的搜索、下载或模型请求。本地布局验收使用样例数据，比较相同尺寸下的行高和可显示行数，并检查长标题、滚动、详情开关和窄屏。

私有备份及验证回执留在服务器 `private-config-backups/knowledge-compact-rows-20261101/`，不提交仓库。切换前检查活动任务和当前基线；回滚只恢复上述两个 PM 镜像，保留七份 Compose、现有数据库、原文和模型配置，不恢复旧业务库或执行 downgrade。是否实际回滚以回执为准。

源站、回环反代和公网真实账号浏览器验收分别记录；不为自动探测的网络 / Cloudflare 限制修改安全设置。
