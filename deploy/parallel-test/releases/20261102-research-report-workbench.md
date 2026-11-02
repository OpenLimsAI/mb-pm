# 研究报告工作台升级（2026-11-02，America/New_York）

用户已授权实现十项改进、提交 main 并部署生产。交付遵循 PR → 最新 CI 全部通过 → squash merge；从合并 main 的固定 40 位提交构建，生产状态以发布回执为准。本记录的初始版本为发布计划，不表示已切换线上。

## 功能与验证

可视编辑、AI 指定位置插入和撤销、知识库精确选段及回到原文、自动和命名快照及单章恢复、资料范围逐项管理、对话主题管理和取消、章节层级与模板、本人服务端笔记引用、结构化导入导出、主页项目和标签组织。使用边界见 [研究报告工作台](../../../docs/research-report-workbench.md)。

发布前已运行前端全仓测试、类型检查、ESLint、构建安全与生产登录检查，后端全仓测试、Ruff 和格式检查；测试计数及最终候选验收记录在发布后的补充文档。真实浏览器检查可视中文输入、选区操作、表格、版本快照及文件导出。知识库配套 PR #39 的类型、覆盖率、构建、39 项浏览器测试、依赖与容器安全检查全部通过。

## 数据库与运行边界

017 为追加迁移，仅为报告增加 pinned、tags，并创建 solution_templates、solution_topics；不导入旧本机笔记，不重写历史报告、正文、引用或笔记。部署助手先对生产数据库的独立副本重复执行 upgrade 017，并通过合成账号检查保存、命名版本 CAS、自动快照、单章恢复、模板、主题、笔记跨账号隔离及 Word 内部结构；不调用真实模型，不向生产库写验收记录。

先备份 PostgreSQL、运行配置及模型文件。保留七份 Compose：compose.yml、compose.production.yml、compose.direct.yml、releases/header-9516977/compose.no-note-sync.yml、releases/assistant-dikw-e294fdc/compose.knowledge.private.yml、releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml、releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml。仅切换 app、app-direct 的固定镜像，保留真实登录、后台助手 worker、知识源 worker 与原有挂载网络；笔记旧同步 worker 继续关闭。

基线及回滚镜像为 mb-pm:assistant-async-0d7fa1d-20261102（sha256:695bbab97e78773ffc3993693066b5185145dfc901f60b59a0193f4129b10174）。采用标准 Dockerfile，强制 SOURCE_REVISION 与真实 API；镜像内部静态清单逐文件哈希校验，并导出实际镜像静态文件复验匿名登录表单。切换前重新核对在线版本、配置及活动任务，使用全局发布锁。两个实例都要健康、匿名受保护接口 401、知识资料只读可达。回滚只切回兼容旧镜像，保留 017 表，不恢复业务数据库、不执行 downgrade。

## 知识库配套

固定源码 fb85df15c1e65ebf162ba1e84905dc5d228b235e（OpenDIKW/dikw-mbweb PR #39）。增加双向选段与定位消息，验证精确 origin、iframe window、来源路径和选段长度；不携带账号凭据，不编造页码，仍由后端验证原始证据与版本。标准 Dockerfile 构建，保留 OIDC、服务端笔记、文件夹桥接及原资料。备份 SQLite 在线快照、Core 数据库和原件；不改动 Core 镜像或模式。

知识库基线及回滚为 dikw-mbweb:knowledge-sources-9eb47fd-20261101（sha256:e1240c59086763a52a633e2cdefd986843163f0696bd41b712d1767d8b3aa439）。候选检查与生产切换分开执行，回执和敏感备份仅留在服务器。
