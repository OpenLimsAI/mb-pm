# 助手回答与来源提示（2026-11-02，America/New_York）

通用问答正文直接回答问题，回答上方显示“通用回答 · 未查询知识库 · 未联网”。后端避免将空的可选资料字段发送给模型，提示词不再诱导不相关的技术说明；仍允许在缺少必要实验数据、证据不足或用户询问来源时，用普通语言说明限制。不正则删除回答段落，不改写已有对话或产物，不隐藏真正的知识库 / 模型错误。

## 固定源码与发布状态

- 用户本轮明确要求修复并部署客户生产。遵循 PR → 最新提交全部 CI 成功 → squash merge，首次将本记录合入 main 的 squash 提交为固定源码。
- 本次更新后端应用及静态文件；依赖和迁移保持不变。构建前核对当前生产依赖及完整配置。
- 目标镜像为 `mb-pm:assistant-answer-copy-<固定提交前七位>-20261102`；源码、镜像 ID、包摘要及部署结果以服务器 `/home/prometheus/mb-pm-v2/releases/<镜像标签>/{image,verification,operations}.json` 为准。成功回执出现前不宣称完成部署。
- 准备时基线与回滚目标为 `2d91745161115fc74ef56afbf1fceb0bb7ea30d3` / `mb-pm:knowledge-select-category-20261102`，镜像 ID `sha256:ec26000f2a113afa5c76a39aee039cd693332cb8a5692eb2ddf2fcf01966a150`。切换前再次核对，基线发生变化则重新准备，保留并行发布。

## 配置、验证与回滚

保留完整七份 Compose：`compose.yml`、`compose.production.yml`、`compose.direct.yml`、`releases/header-9516977/compose.no-note-sync.yml`、`releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`、`releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`、`releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`。

仅更新 app / app-direct。先备份数据库、配置和模型设置，在隔离生产库副本验证候选版本、来源路由、鉴权及原记录保留。关闭候选采集 worker；如执行真实模型检查，仅使用新建的隔离任务与公开测试问题，不修改客户正式任务、不触发新的搜索或资料下载。提示词修改的静态 / 模拟测试与真实模型验收分别记录，不能互相替代。历史问答继续保留原文。

完成相关前后端回归、类型与格式检查、构建和全部 CI 后，再从固定 main 源码构建。切换前核对发布锁、活动任务、两个实例的基线与完整七份配置，备份本次诊断日志；切换后检查健康、匿名鉴权、只读知识库连接、来源标签、模型设置摘要、原记录与非目标容器。分别记录源站、回环反代及公网验收，不为自动探测限制修改边缘安全设置。

本次目录的 `compose-production.sh` 和 `operations.json` 作为运维入口；私有备份存于 `private-config-backups/<镜像标签>/`，不提交。失败回滚只恢复两个 PM 镜像，保留现有七份配置、业务数据库、论文原件和模型设置，不执行数据恢复或 downgrade。
