# 知识源：来源下载与文件夹整理 · 2026-11-01

本轮把「从来源下载」作为突出入口，以可搜索、筛选和直接归类的文件夹卡片管理现有论文。每个来源页面内嵌可下载清单，支持关键词、分类、保存状态与 NEW 筛选、分页、跨页选择及提交下载；不再打开可下载论文预览弹窗，文件夹与来源配置窗口仍保留。再次搜索只更新目录，不自动下载或建立索引。本记录随实现一同交付，**不预先表示已经上线或完成真实账号验收**。

## 固定源码与发布状态

本轮固定源码为 **首次将本文件加入 `main` 的 squash 合并提交**，而不是开发分支提交或后续任意 main。PR 最新提交的全部 CI 通过并合并后，从该固定提交官方导出源码，逐 Git blob 核验，再构建 `mb-pm:knowledge-source-discovery-20261101`。原资料下载、KB 桥接与权限校验继续沿用已有实现，不恢复旧行业信息监控。

仓库中的本记录描述发布契约；实际是否完成生产切换、精确 SHA、Git tree、镜像 ID、发布包摘要和执行结果，以服务器以下回执为准。缺少最终成功回执时，应视为尚未完成发布，不能把预案写作验收结果。

| 记录 | 服务器路径（均不含公开密钥或令牌值） |
|---|---|
| 源码 / tree / 镜像 / 包摘要 | `/home/prometheus/mb-pm-v2/releases/knowledge-source-discovery-20261101/image.json` |
| 部署验证、数据保留、回滚目标 | 同目录 `verification.json` |
| 运行组合与启动入口 | 同目录 `operations.json`、`compose-production.sh` |
| UI 与只读探针摘要 | 同目录 `qa-scripts.json` |
| 私有备份及详细验证 | `/home/prometheus/mb-pm-v2/private-config-backups/knowledge-source-discovery-20261101/` |
| 源站 / 反代 / 公网边界 | 私有备份目录内 `route-verification.json` |

本轮发布前只读基线为 PM `34c012652e54dc2563101b6e00dfebca1541faae` / `mb-pm:portal-knowledge-ui-20261101`，KB `9eb47fdb58cb0949fc6e6bb62a699adc90bcc553` / `dikw-mbweb:knowledge-sources-9eb47fd-20261101`。当时两个 PM 与 KB healthy。执行前仍须复核；若代码、镜像或 Compose 基线变化，先评估并行变更，不能覆盖或回退他人发布。

## 功能与 NEW 边界

- `document.isNew` 始终是布尔值，由后端根据已保存搜索范围与每篇 `newInScopes` 推导，不由浏览器臆测发现时间。
- 首次成功检查某范围只建立基线，不把整站标为 NEW；随后成功搜索的新条目优先显示，下次该范围成功搜索刷新其标记。失败或未检查范围保留先前结果与标记，已知条目出现在另一分类不当作新论文。
- 文件夹卡片可按名称与类型筛选；已选论文可直接放入目标文件夹，保留已有分类，不复制或移动原件。来源任务未结束或已暂停时，保留已选条目并阻止该来源重复搜索 / 提交下载。
- 知识源私有界面使用 `kso-*` 命名及 `#knowledge-source-app` 作用域，避免研究报告裸 `.ks-*` 样式影响；共享账号 / 主题操作继续使用 ApplicationActions。需在先加载研究报告 CSS 的情况下复核入口按钮、白色文件夹卡和工作区布局。

## 运行与数据保护

仅重建 `app` 与 `app-direct` 两个 PM 实例；KB 及其余 15 个容器不重建。新版本不新增数据库迁移，不删除或回退既有 `014`、`015`；发布时对包内迁移源码与原镜像逐项比较，差异必须停止。

完整保留现有六份 Compose 覆盖，不能因本次 UI 修改省略私有连接或手动 worker 开关：

1. `compose.yml`
2. `compose.production.yml`
3. `compose.direct.yml`
4. `releases/header-9516977/compose.no-note-sync.yml`
5. `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`
6. `releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`

后续操作使用本次发布目录的统一 wrapper，并核对 `operations.json`。全部文件均相对于 `/home/prometheus/mb-pm-v2`：

```sh
/home/prometheus/mb-pm-v2/releases/knowledge-source-discovery-20261101/compose-production.sh ps
```

`INFORMATION_APP_ENABLED=false` 保持，`KNOWLEDGE_SOURCE_APP_ENABLED=true` 与 `KNOWLEDGE_SOURCE_WORKER_ENABLED=true` 继续沿用。新 worker 只执行用户明确创建的知识源任务，发布、打开页面和读取清单不应自动发起采集、下载、索引或模型请求。存在运行中的显式手动任务时，延迟切换，保留任务和原件。

备份包括在线 PostgreSQL dump、运行配置、原文共享卷、AI 设置文件及原容器诊断日志，保存在服务器受保护目录。隔离候选使用恢复的数据库和原件 / 模型设置副本，后台 worker 关闭；只读核对真实 Core 与当前可读 KB 角色，不伪造用户会话、不创建测试论文或付费模型任务。

既有论文数量与归档数量分别核对，不能把“已归档但尚未进入 Core”误当重复或无效资料。候选与切换后检查既有业务 ID、助手消息 / 报告 / 笔记内容摘要、模型配置、原件哈希和文件夹主关联；未知解析 / 索引状态不升级为 ready。基线中资料会随用户主动操作增长，最终数量以回执为准，不写死旧的 63 篇或旧原件数。

## 验证范围与外部限制

发布门槛包含最新 PR 全部 CI、根代理的 UI 流程与响应式检查、固定源校验、隔离候选、两个 PM 服务健康、匿名鉴权、真实库只读连接、旧队列保持、手动 worker 启动记录以及旧数据 / 消息 / 原件保护。旧 worker 关闭以真实启动门控、运行配置和旧任务摘要保持为证，不使用 `docker exec` 子 Python 的线程列表推断 ASGI 线程。

源站及本机反代需核对固定 index / 静态资源摘要和匿名 API 401。公网网站与真实账号登录后的浏览器验收须分别记录；此前 IAB 导航 / DOM 读取曾超时，服务器到公网域名也有 403 或网络超时。不能将源站成功写作公网完整验收，不为此关闭 Cloudflare 安全设置，不使用或导出客户已有会话。

本轮验证不主动执行生产新下载、批量抓取、论文索引或付费模型问答。NEW 标记与再次搜索行为由针对测试及本地样例 UI 检查覆盖；候选 / 上线只读验证只检查既有目录返回 `isNew` 布尔值和新界面产物，不在生产发起再次搜索、下载或修改分类。真实来源和业务写入验收保留给用户主动操作。

## 回滚

本轮回滚目标为 `mb-pm:portal-knowledge-ui-20261101`；执行前核对该旧镜像 ID 与本轮备份一致。使用发布目录的 `deploy.py rollback`，传入 `image.json` 中的固定源码 SHA 与发布包 SHA-256，仅恢复两个 PM 的镜像标签及必要运行配置，并继续使用完整六份覆盖。

回滚不恢复旧业务数据库、不删除论文 / 原文 / 文件夹 / 消息、不撤销 `014` / `015` 或多文件夹成员关系，保留上线后新增资料。KB 不回滚、不重建；不得执行全栈 `down`、删除卷或用本地示例覆盖服务器私有环境。

实际回滚状态由私有备份目录的 `rollback.json` 记录；未执行演练时，不将预案描述成已实测回滚。
