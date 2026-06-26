# CMC-PMS · CTO 决策视图（Lite）

面向制药厂 **CTO / 研发高管** 的研发项目组合管理应用。从 CMC-PMS 完整系统裁剪而来，
保留高管纵览所需的核心模块，去掉登录与角色切换，直接以「CMC 负责人（全局视图）」身份进入。

**前后端分离的小型应用**：React 前端 + FastAPI/SQLite 后端，数据真实持久化（非纯演示）。

> 前端端口 **5175**，后端 **8000**。

## 模块

| 模块 | 路由 | 作用 |
|------|------|------|
| **首页** | `/` | 项目组合总览：组合 KPI（在研项目 / 总进度 / 待达里程碑 / **风险项** / 关键路径 / 预算执行）、**风险预警**（拆分为「进度风险」与「质量与合规风险」两族，质量门里程碑可派生、偏差/CAPA/批次留有接入位）、项目健康度红黄绿分组卡片、组合预算。 |
| **项目** | `/projects` | 项目列表（卡片 / 表格 / 组合矩阵）+ **从模板创建项目**（向导第 3 步可增删任务后再创建）+ 项目详情：**WBS**（可行内编辑表格 / 树 / 甘特三视图）、**里程碑**（达成条件 ↔ WBS 任务关联，可新建/编辑/删除）、**基线对标**（冻结计划快照、对标进度/成本漂移）、**团队**（项目成员管理）+ **任务进展录入**（自动汇总）。 |
| **模板** | `/templates` | 研发流程标准模板目录 + **新建模板**（空白 / 复制现有）+ **可视化结构编辑器**（增删改子项目/任务/里程碑/依赖、保存为新版本）+ 模板详情 / 甘特预览 / 导出 Excel / 删除。 |
| **组织** | `/org` | 组织成员目录 + **增删成员**（新增、停用/启用、删除——仍负责项目/任务的成员受引用守卫保护）。 |

## 运行（全栈）

需要两个终端。**先起后端，再起前端**：

```bash
# 终端 1 —— 后端（FastAPI + SQLite，首次自动建环境+建库+灌种子）
cd backend && ./run.sh                 # http://127.0.0.1:8000  （文档 /docs）

# 终端 2 —— 前端
npm install
npm run dev                            # http://localhost:5175
```

- 前端通过 `.env.local`（`VITE_USE_API=true`）连接后端。
- **后端未启动时前端自动回退到内置 mock 数据**（离线只读，顶部提示），起后端后刷新即恢复持久化。
- 构建：`npm run build`（`tsc -b && vite build`）。

## 关键实现

- **真实后端持久化**：项目 / 子项目 / 任务 / 依赖 / 模板存于后端 SQLite。前端启动时以 CTO 身份登录后端拿 JWT，拉取全量数据填入运行时数据层（`src/data/bootstrap.ts`）；所有 mutation 走 API 后重新同步。
- **任务进展录入 + 自动汇总**：在「项目详情 → 点击任务」抽屉里录入 `状态 / 进度% / 实际起止 / 实际工时`，`PATCH /tasks/{id}` 写后端并自动重算 **子项目 → 项目** 进度（`backend/app/services/rollup.py`）。
- **模板实例化创建**：`lib/instantiate.ts` 把模板树展开为三级任务树（拓扑排期 + 状态/进度派生），经 `POST /projects/import` 整包落库。
- **无登录单一 CTO 视图**：固定为郭主任（cmc_lead，全局组合权限），契合 CTO「看全部」诉求。
- **数据基线**：DMP v3.6 模板 + 3 个示例项目（MAB-201/202/203，各 33 任务），前后端用同一份种子（`scripts/dump-seed.mjs` → `backend/app/seed/seed.json`）。

## 目录

```
项目管理系统_Lite/
├── src/                 前端（React 19 + TS + Vite + Tailwind v3 + Zustand）
│   ├── data/bootstrap.ts   引导 + 数据同步 + mutations
│   ├── api/                Axios 客户端（snake↔camel 转换 + JWT）
│   └── pages / components / store / lib / mock
├── backend/             后端（FastAPI + SQLAlchemy + SQLite）—— 见 backend/README.md
└── scripts/dump-seed.mjs   前端数据 → 后端 seed.json
```

技术栈：React 19 · TypeScript · Vite · Tailwind CSS v3 · Zustand ｜ FastAPI · SQLAlchemy 2 · SQLite。
