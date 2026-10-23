# CMC-PMS · 迈博药业应用门户与项目管理

## 项目简介

面向制药企业管理者与研发团队，提供员工应用门户和 CMC 研发项目管理。
门户连接项目管理、知识库和信息获取，项目管理顶栏可返回应用工作台；身份及角色由 mb-casd（Casdoor）IAM 统一管理。
本仓库包含门户、项目管理前后端及信息获取交互首版；知识库是独立服务。

## 快速启动

需要 Node.js 20.19+。在项目根目录执行，先预览界面：

```sh
npm ci
VITE_USE_API=false npm run dev
```

打开 `http://localhost:5175/login`，点击「界面预览」；项目管理演示入口为 `/dashboard`。
此模式不验证登录、不连接客户数据库。真实运行需 Python 3.11、后端及可访问的 IAM，
配置和启动步骤见 [本地开发与测试](docs/development.md)。
本地工作台的知识库入口默认进入同一主机的 4322 端口，需另行启动知识库前端。

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
| 员工门户 | 本页直接登录，工作应用与管理功能分区，另提供我的设置与帮助 |
| 信息获取 | 独立应用的七页交互体验，使用演示数据，真实采集和入库后续接入 |
| 账号管理 | 平台身份与 PM、知识库负责人 / 用户分区维护，管理员可改、项目负责人只读 |
| 项目总览 | 组合指标、风险预警、个人看板 |
| 项目与模板 | 空白或模板创建、项目复制、编辑项目（预算与 WBS 结构统一保存）、里程碑、基线与团队 |
| 任务与甘特 | 按项目结构查看任务、四状态进展录入、依赖、关键路径与延迟推演 |
| 人员负荷 | 周负荷、过载提醒与任务改派 |
| 财务 | 项目及任务预算、实际花费与成本汇总 |
| AI 分析 | 限系统管理员 / 项目负责人；模型及提示词在项目管理「AI设置」配置 |
| 版本更新 | 在工作台查看功能说明与历史更新记录 |

入口、操作边界、预算口径及待开发事项见 [功能说明](docs/features.md) 和 [信息获取首版](docs/information.md)。

## 配置与权限

前端参考 [`.env.local.example`](.env.local.example)，后端参考 [`backend/.env.example`](backend/.env.example)。
真实登录须填写 IAM 客户端配置及随机会话密钥，生产 HTTPS 启用 Secure Cookie。

账号和角色在 IAM 管理，日常通过门户「账号管理」维护（仅系统管理员 / 项目负责人可见）；个人用户名、密码在门户「我的设置」，模型与提示词在项目管理「AI设置」。项目管理默认对组织内所有人开放，知识库需对应 KB 角色。
门户、PM 与 KB 各自检查权限并维护会话，跨应用 SSO 须单独验收。
变量、回调、开通方式及退出范围见 [配置与权限](docs/configuration.md)。

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
知识库：<https://kb.openlims.ai>；IAM：<https://iam.openlims.ai/login>。

环境状态、备份、发版、验收与回滚以 [部署交接简明](docs/部署交接简明.md) 为准，
历史发布材料见 [部署记录](deploy/parallel-test/README.md)。数据库结构变更需单独规划迁移。

## 更新记录链接

- [CHANGELOG](CHANGELOG.md)：历次代码变更。
- [版本更新维护说明](docs/releases/README.md)：维护内容源及生成 HTML。
- [独立版本更新页](public/release-notes.html)：生成的产品说明与历史记录。
- [文档维护约定](AGENTS.md)：本 README 的结构及后续更新规则。
