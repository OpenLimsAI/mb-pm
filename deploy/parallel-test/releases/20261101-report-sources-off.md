# 研究报告资料简化 · 生产发布记录（2026-11-01）

2026-11-01 08:31（America/New_York，UTC−5）完成切换。移除「报告资料」页签、独立资料列表与搜索筛选、手动添加资料和发布定稿入口；资料面板保留原知识库内嵌浏览、刷新、加入问答范围和确认引用。此前已合并的新窗口按钮移除也一并上线。

## 固定版本与构建

- [PR #99](https://github.com/OpenLimsAI/mb-pm/pull/99) 全部 CI 通过后 squash 合并 main，固定源码 `12d89e82ffac8b6998a1513b5d0daf5bdd3530ef`。
- 镜像 `mb-pm:report-sources-off-12d89e8-20261101`，image ID `sha256:726c6392b1525ad81bfce5e1c45cd77e4a3714db690276c42edcb5c8e5299f54`；OCI revision 为上述提交。
- 从固定提交归档构建，包含 main 中已合并的 Kimi / 模型参考价与工作台版块导航。服务器 Docker Hub 的 Node 元数据解析失败，改为用同一固定源码在本机执行正式 API 前端构建，再基于现网镜像完整替换 `/code/app` 和 `/code/static`。运行依赖清单逐字节一致，SHA-256 `f331086d02d622ac819555db7808dbe810cbac8aafa8a57352f6e3495a53efb9`；未重新安装或变更现网运行依赖。
- 最初的替代构建因默认构建忽略规则排除 `dist` 而失败；修正为仅包含 `backend/app` 和 `dist` 的专用构建上下文后成功。失败构建和候选阶段未切换生产。

## 备份与配置

服务器发布目录 `releases/report-sources-off-12d89e8-20261101/`，回执为其 `receipt.json`；私有备份位于 `private-config-backups/report-sources-off-12d89e8-20261101/`，含数据库、配置、诊断记录和前一镜像信息，未下载到本机或提交 Git。数据库归档 SHA-256 `e39c37ea217b7958747094192fc994c0d59b85393f19a0b1147a12e297a88009`。

保留完整五文件 Compose：`compose.yml`、`compose.production.yml`、`compose.direct.yml`、`releases/header-9516977/compose.no-note-sync.yml`、`releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`。展开配置仅改变应用镜像；网络、卷和日志设置核对一致，知识库连接完整，笔记后台同步继续关闭。

## 验证

- 本地研究报告 28 个测试文件、354 项测试通过，TypeScript 与生产构建通过。布局与引用测试改为从原知识库选择文献，保留布局切换中的正文、问题、资料范围与 iframe。
- 在无外部网络的临时 PostgreSQL 中恢复生产备份并启动候选；38 张表数量以及个人资料、报告和笔记内容摘要与备份一致。候选页面 200、匿名报告 API 401，新资源无报告资料页签及弹出窗口入口，保留文献引用操作。临时容器和临时环境文件已清理。
- 两个实际生产实例 healthy，匿名报告 API 均为 401，各自成功读取 63 篇知识库论文。发布前后 38 张表记录数一致，`solution_sources`、`knowledge_solutions`、`personal_notes` 内容摘要一致。近期启动日志未观察到 Traceback / startup failed / uncaught / unhandled。
- 公网研究报告页面与 PM 健康返回 200，匿名报告 API 为 401；`Solutions-aqGyN8f6.js` 返回 200，内容 SHA-256 与固定提交构建产物一致。
- 本轮未写入客户报告、笔记或论文，未执行客户账号下的写作及生成模型问答；该真实业务验收仍需后续进行。既有资料及兼容接口保留，未删除旧数据或执行数据迁移。

## 回滚

前一镜像 `mb-pm:assistant-rounds-ba3ddae-20261101`，image ID `sha256:bcbba8568337fac3ed6d84f8f9aba60407509b67d9f6e7f18c6ee9b16bfd6959`。确认当前仍为本次版本后，仅将 `.env` 的 `PMS_IMAGE_TAG` 改回前一 tag，用上述完整五文件 Compose 分别重建 `app` 与 `app-direct`，复查健康、匿名鉴权和知识库读取。保留全部数据库和卷，不用备份覆盖上线后的业务写入。
