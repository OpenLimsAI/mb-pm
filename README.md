# CMC-PMS · 迈博药业应用门户与项目管理

## 项目简介

面向制药企业管理者与研发团队，提供员工应用门户和 CMC 研发项目管理。
工作台从上到下分为 AI 智能、知识信息、业务管理和功能设置四个版块，连接 AI 助手、研究报告、我的笔记、知识库与项目管理；身份及角色由 mb-casd（Casdoor）IAM 统一管理。
各应用采用极光青高效工作台：浅色顶栏、紧凑导航与统一返回入口；项目默认卡片直达，研究报告保留富文本、引用、版本与导出。
我的笔记保留分类侧栏与笔记编辑界面；报告入口默认进入主页。设计规范与验收边界见[高效工作台](docs/efficient-workspace.md)。
旧行业信息保持下线；「知识源」管理共享论文与文件夹，支持 ICH 下载、报告/助手参考论文导入、版本核验及按需启用的定期检查。
本仓库包含门户、项目管理前后端、AI 助手、研究报告、独立笔记及知识源应用；企业知识库是独立服务。

## 快速启动

需要 Node.js 20.19+。在项目根目录执行，先预览界面：

```sh
npm ci
VITE_USE_API=false npm run dev
```

打开 `http://localhost:5175/login`，点击「界面预览」；项目管理演示入口为 `/dashboard`。
此模式不验证登录、不连接客户数据库。真实运行需 Python 3.11、后端及可访问的 IAM，
配置和启动步骤见 [本地开发与测试](docs/development.md)。
本地工作台的知识库入口在当前标签页进入同一主机的 4322 端口，需另行启动知识库前端。

## 架构

React 19 / TypeScript / Vite 前端 + FastAPI / SQLAlchemy 后端。
生产构建为同一个 Docker 镜像，同源提供页面及 API；生产使用 PostgreSQL，本地可用 SQLite。
门户与 PM 按域名分流，IAM 与知识库独立运行。

```text
src/       页面、组件、状态与 API 客户端
backend/   接口、权限、数据模型及测试
docs/      功能、配置、开发与部署说明
deploy/    部署配置及历史发布记录
```

系统拓扑、身份流程及关键实现见 [架构说明](docs/architecture.md)。

## 功能概览

| 功能 | 作用 |
|---|---|
| 员工门户 | 顶部导航直达四个版块，主数据和账号管理收于功能设置 |
| 回音壁 | 按应用附图反馈、回复讨论并记录修复说明 |
| AI 助手 | 后台问答与停止恢复、项目/知识库来源、长期任务摘要和运行诊断 |
| 知识源 | 组合选择下载、可撤销文件夹整理、版本更新与用量、按需定期检查及研究衔接 |
| 研究报告 | 连续写作、AI 修改对比、证据引用、协作批注、笔记联动、质量检查与成稿导出 |
| 我的笔记 | 独立个人记录、跨应用摘录、来源保留、搜索编辑与回收站 |
| 账号管理 | 平台身份与 PM、知识库负责人 / 用户分区维护，管理员可改、项目负责人只读 |
| 项目总览 | 统一到期口径、风险直达、个人看板与站内通知 |
| 项目与模板 | 卡片直达、项目 Excel 往返、模板选择性升级及可解释加权进度 |
| 任务与甘特 | 按项目结构查看任务，长名称悬浮全文、名称栏拖动调宽，甘特图固定日期与工具栏并支持缩放 |
| 人员负荷 | 按工作日历、协作者分摊和每周容量计算剩余负荷，支持请假及任务改派 |
| 财务 | 项目及任务预算、实际花费与费用明细对账及完工预测 |
| AI 分析 | 项目后台分析、历史检索与对比，建议经确认转为任务、风险或联动排期 |
| 模型与参考价 | 支持 Kimi，选择时展示已核实的单价、币种、计费档位和官方来源 |
| 版本更新 | 在工作台查看功能说明与历史更新记录 |

自动问答与搜索配置见[使用说明](docs/assistant-auto-search.md)；DeepSeek 官方搜索可复用当前模型密钥，须由管理员启用。
项目协同、交付验收、联动排期、全任务基线及台账见[项目执行与协同](docs/pm-execution-improvements.md)。
Excel 回导、模板升级、进度权重及 AI 行动见[项目计划工具](docs/pm-planning-tools.md)。
入口与边界见 [功能说明](docs/features.md)、[AI 助手](docs/ai-assistant.md)、[知识源](docs/knowledge-sources.md)、[研究报告工作台](docs/research-report-workbench.md) 和 [研究报告体验升级](docs/research-report-experience.md)。
工作台 `/model-settings` 是个人模型统一入口，供知识库问答、翻译、摘要和标签复用。配置与授权边界见[知识库统一模型接口](docs/knowledge-ai-integration.md)，环境发布状态见[发布契约](deploy/parallel-test/releases/20261104-knowledge-unified-ai.md)。

## 配置与权限

前端参考 [`.env.local.example`](.env.local.example)，后端参考 [`backend/.env.example`](backend/.env.example)。
真实登录须填写 IAM 客户端配置及随机会话密钥，生产 HTTPS 启用 Secure Cookie。

账号和角色在 IAM 管理，日常通过门户「账号管理」维护（仅系统管理员 / 项目负责人可见）；个人用户名、密码在门户「我的设置」，PM 全局模型与提示词在项目管理「AI设置」。研究报告内的个人模型按账号独立保存，不授予或改变 PM 全局配置权限。项目管理默认对组织内所有人开放，知识库需对应 KB 角色。
门户、PM 与 KB 各自检查权限并维护会话。门户与 PM 支持活跃续期，研究报告可在重登后恢复工作现场；时限、旧会话过渡与诊断见[会话配置](docs/configuration.md#独立门户与会话)。跨应用 SSO 须单独验收。
变量、回调、开通方式及退出范围见 [配置与权限](docs/configuration.md)；原件、模型设置及密钥备份见[容器持久化](docs/configuration.md#容器业务数据持久化)；Kimi 与定价范围见[模型价格参考](docs/model-pricing.md)。
MDM 登记项目与 PM 执行项目的一对一关联见 [MDM 整合](docs/mdm-integration.md)；委托创建、统一退出及本阶段验收边界见 [第二阶段](docs/mdm-phase2.md)。

## 测试

安装开发依赖后，在项目根目录执行：

```sh
npm run build
npm run test:coverage
node scripts/test-portal-routing.mjs
(cd backend && .venv/bin/python -m pytest -q)
```

依赖安装、测试库要求及 CI 范围见 [本地开发与测试](docs/development.md#构建与测试)。
自动测试通过不代表真实用户登录或跨应用 SSO 已通过验收。
账号权限模块的覆盖率范围和 90% 门槛见上述测试说明。

## 部署

员工门户：<https://www.openlims.ai>；项目管理：<https://pm.openlims.ai>。
旧行业信息入口：<https://www.openlims.ai/information>，显示下线说明；实际环境状态见发布记录。
知识库：<https://kb.openlims.ai>；IAM：<https://iam.openlims.ai/login>。
主数据管理：<https://www.openlims.ai/mdm/>；路径路由、独立鉴权及迁移验收见[发布记录](deploy/parallel-test/releases/20261102-mdm-www-path.md)。

环境状态、备份、发版、验收与回滚以 [部署交接简明](docs/部署交接简明.md) 为准，
历史发布材料见 [部署记录](deploy/parallel-test/README.md)。数据库结构变更需单独规划迁移。
安全控制、备份调度、最终镜像及剩余边界见 [2026-11 安全发布记录](deploy/parallel-test/releases/20261103-security-hardening.md)。
生产前端使用 `SOURCE_REVISION=<固定完整提交> npm run build:production`；发布前校验最终产物及匿名登录表单，见[生产构建检查](docs/production-build.md)。

## 更新记录链接

- [CHANGELOG](CHANGELOG.md)：历次代码变更。
- [版本更新维护说明](docs/releases/README.md)：维护内容源及生成 HTML。
- [独立版本更新页](public/release-notes.html)：生成的产品说明与历史记录。
- [文档维护约定](AGENTS.md)：本 README 的结构及后续更新规则。
