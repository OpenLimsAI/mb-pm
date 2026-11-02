# 知识源全选本类（2026-11-02，America/New_York）

“全选本类”放在“全选本页”旁。选择 Q/S/E/M 分类后，跨全部分页选择该分类及当前关键词、下载状态匹配的文件；默认未下载，已全选时禁用重复选择。切换分类保留先前选择并去重，点击既有“下载所选”才提交一个任务，不自动下载。只读用户不显示选择入口，运行或暂停任务仍阻止重复下载但允许预选。

## 固定源码与发布状态

- 遵循 PR → 最新提交全部 CI 成功 → squash merge。首次将本记录合入 main 的 squash 提交为固定源码，从该提交构建生产静态文件。
- 本次仅前端与文档；发布前核对后端、依赖和迁移与当前生产一致，只替换静态文件。
- 目标镜像 `mb-pm:knowledge-select-category-20261102`；源码、tree、镜像 ID、包摘要及实际验收以服务器 `/home/prometheus/mb-pm-v2/releases/knowledge-select-category-20261102/{image,verification,operations}.json` 为准，成功回执出现前不预称上线。
- 发布前基线 / 回滚目标为 `920f89a5b37bc6ecfeb33e90935c9d416bf53017` / `mb-pm:assistant-task-actions-920f89a-20261101`，镜像 ID `sha256:ba4d994c10c32fbd15be2dd6b1c85509c5934ab26d0600b335ea8800482ba0ea`；保留最新任务删除、紧凑行距与列表高度修复。

## 配置、验证和回滚

保留完整七份 Compose：

1. `compose.yml`
2. `compose.production.yml`
3. `compose.direct.yml`
4. `releases/header-9516977/compose.no-note-sync.yml`
5. `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`
6. `releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`
7. `releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`

本次目录 `compose-production.sh` 为运维入口，只更新 app / app-direct，不改 KB、模型设置、原件或既有业务记录，无新迁移。先备份并建立隔离生产库、原件和模型副本，关闭候选采集 worker；验证原有论文、原件摘要、NEW 类型、消息及配置，不执行生产新搜索、下载或模型请求。跨分页、跨分类去重、筛选条件、权限和任务锁由前端回归及明确的本地样例验证，不冒充生产真实账号写入。

私有备份与回执留在服务器 `private-config-backups/knowledge-select-category-20261102/`，不提交 GitHub。切换前复核活动任务、基线和完整配置；回滚只恢复两个 PM 镜像，保留七份配置、数据库、原文和模型，不恢复旧业务库或执行 downgrade。是否实际回滚以回执为准。

分别记录源站、回环反代与公网浏览器验收；不为网络 / Cloudflare 探测限制修改安全设置。
