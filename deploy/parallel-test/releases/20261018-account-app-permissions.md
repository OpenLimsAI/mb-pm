# 平台身份与应用权限分离上线记录

2026-10-18 17:24（Asia/Shanghai，UTC+8）完成生产切换。系统管理员单独设置，PM 业务角色与知识库权限分别维护；知识库只可选「可编辑」，「仅阅读」置灰。生产浏览器已核对面板，客户实际改权后的 PM / KB 重新登录与业务操作仍待验收。

## 交付与版本

| 项目 | 实际值 |
|---|---|
| 功能 PR | [#22](https://github.com/OpenLimsAI/mb-pm/pull/22)，5 项 CI 全部通过后 squash merge 为 `0f43277638231b4ffb41f06780040cbec9f9b9b1` |
| 正式版本说明 PR | [#23](https://github.com/OpenLimsAI/mb-pm/pull/23)，5 项 CI 全部通过后 squash merge；仅补全更新说明 |
| 构建源码 | 合并后的 `main`：`0750183b195024e615ca458ea32def32f6bb653b`，与 #23 已验证的 PR 树一致 |
| CI | [功能 PR](https://github.com/OpenLimsAI/mb-pm/actions/runs/39114330524)、[版本说明 PR](https://github.com/OpenLimsAI/mb-pm/actions/runs/39114849777)、[部署源码 main](https://github.com/OpenLimsAI/mb-pm/actions/runs/39114966156) 均全部通过 |
| 新镜像 | `mb-pm:account-permissions-20261018T092058Z` |
| 镜像 ID | `sha256:4d7d7c53876f24330afbcdd7347669cfdc73f308258e25e0833f9ad22fc2c001` |
| 回滚镜像 | `mb-pm:workspace-20261018T062747Z` |
| 源码快照 | `/home/prometheus/mb-pm-v2/releases/account-permissions-20261018T092058Z/`，236 个源文件，逐文件清单为 `source-state.json`；镜像标签同时记录源码提交 |
| 源码包 SHA256 | `f2c61190d4932913b5ec57daf00ff392a0f364351ff58bf01d617e0c58aa67e9` |
| 正式入口脚本 | `/assets/index-Chq6vGXd.js`；权限页面分包 `assets/PortalAccounts-Dt4J13jB.js` |
| 切换窗口 | 2026-10-18T09:23:53.503787Z 至 09:24:24.737879Z，检查共约 31 秒；不是逐请求测量的停机时长 |

本次将 **PR → CI 全部通过 → squash merge → 从合并后的 main 部署** 写入根 `AGENTS.md`。发布后的文档补充也走 PR；纯文档调整不重建生产应用。

## 构建与备份

后端运行依赖与前一镜像一致，差异仅为依赖清单的 LF / CRLF 换行；比较归一化后的完整文本后，复用原 Python 依赖层，完整替换 `/code/app` 与 `/code/static`，没有数据库结构迁移。

服务器 Docker 镜像源曾对 `docker/dockerfile:1` 返回 502。重试使用 Docker 内置构建前端，派生的 `Dockerfile.frontend-build` 仅去掉语法指令注释，其余构建步骤及 main 源码未改动。实际过程保存在源码目录的构建 / 验证脚本与 `Dockerfile.application-update`。

备份位于 `/home/prometheus/mb-pm-v2/private-config-backups/account-permissions-20261018T092058Z/`：

- PM / IAM 数据库 dump 及切换前再次生成的 `pms-before-switch.dump`，均通过 `pg_restore -l` 校验。
- `.env`、`app.conf`、三份 Compose、直连 Caddyfile、AI 设置、前一镜像及容器清单。私密文件只留服务器，目录 700、文件 600。
- `candidate-checks.json`、`deployment-receipt.json`、`data-before-switch.json`、`public-checks.json`、`candidate-retention.json`。

只重建 `app` 与 `app-direct`。其余 11 个生产容器 ID 不变，包含 PM / IAM 数据库、Casdoor、Tunnel、直连代理及全部知识库服务。环境变量、Compose、`app.conf`、AI 设置核对不变；`.env` 仅更新 `PMS_IMAGE_TAG`。

## 验证与数据

| 范围 | 结果 |
|---|---|
| 本地 TDD | 前端 39 项、PostgreSQL 后端全量 282 项、SQLite 账号接口 66 项通过；模块覆盖范围和指标见[验证记录](../../../docs/design/accounts-app-permissions-verification.md) |
| GitHub CI | 前端逐文件四项 90% 门槛及后端分支测量的综合 90% 门槛通过；类型检查、构建、路由、后端格式与 Docker 构建通过 |
| 最终候选 | 62 项通过；生产 PM 与 IAM 副本运行在独立 internal 网络，真实 Casdoor 完成 22 次测试写调用，生产账号权限未修改 |
| 权限行为 | 平台 / PM / KB 独立更新，历史角色保留，KB 显式升级，旧格式 / viewer 写入拒绝，负责人只读，自身降权保护；真实 IAM 写入后的数据库失败补偿通过 |
| 正式服务 | 两个应用均 healthy；`direct_entry.py check` 通过，启动日志没有错误 |
| 公网 | 21 项通过，包括门户 / PM / IAM / KB 入口、匿名受保护接口 401、IAM CORS、版本说明、入口脚本及权限分包与镜像内容一致 |
| Chrome | 原 IAM 会话自动登录回门户；列表三列权限、编辑面板三分区、管理员 PM 继承、KB 仅阅读禁用与可编辑选中、无修改时保存禁用均已核对；未保存或改变线上账号权限 |

切换前后逐行归一化 SHA256 一致的九张业务表：项目 2、子项目 7、任务 34、依赖 38、预算 2、基线 0、成员 5、IAM 绑定 5、项目团队关系 3。没有导入、重置或恢复生产业务数据。

候选检查模拟门户已认证会话，管理 API 与实时角色核对使用真实的隔离 Casdoor，不等同于客户在生产环境改权。生产浏览器只读查看，没有输入客户密码。角色更改后需重新登录对应应用；独立 KB 旧会话不由 PM 立即撤销。客户实际改权后的 KB 编辑能力、历史阅读者受保护写接口和 PM / KB 重新登录仍待真实验收。

两轮隔离候选的 6 个容器均已停止，数据、匿名卷、私密配置、源码和回滚镜像保留，待用户验收后再决定清理；未删除生产卷或旧镜像。

## 回滚

在 `/home/prometheus/mb-pm-v2` 仅将 `.env` 的 `PMS_IMAGE_TAG` 改回 `workspace-20261018T062747Z`，执行：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
curl -fsS http://127.0.0.1:18082/health
python3 direct_entry.py check
```

切换脚本在健康、配置、业务数据或其他容器核对失败时自动执行上述镜像回滚。本次未触发回滚；回滚路径按脚本核对，没有故意制造生产故障演练。不整份覆盖 `.env`，不回退数据库，不执行 `down -v`。IAM 已保存的角色不会随镜像回滚而撤销；回滚后旧账号管理页面仍使用旧权限编辑方式，应先核对线上已发生的权限修改。
