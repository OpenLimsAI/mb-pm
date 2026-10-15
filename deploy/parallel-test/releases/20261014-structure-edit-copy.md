# 项目编辑模式与复制项目上线记录

日期：2026-10-14 00:07（Asia/Taipei，即 2026-10-13T16:07Z）。已部署到 `pm.openlims.ai`（同时更新 IP 直连应急入口）；客户账号的真实操作验收待完成。

## 发布内容

- **编辑模式**：项目概览「三级 WBS」卡片与「WBS」页签右上角进入，与模板结构编辑同一界面和用法；增删改子项目、任务 / 里程碑、前置依赖后一次性保存（`GET / PUT /api/v1/projects/{id}/structure`）。他人同时改过结构时提示重新载入；已开始或已录实际花费的任务不能删除；改日期不自动顺延，冲突行内提示。WBS 树形视图原来无法点击的「+」「…」按钮已移除。
- **复制项目**：项目列表右上角，仅系统管理员 / CMC 负责人（`POST /api/v1/projects/{id}/copy`）。照搬结构与计划，执行数据重置，可指定新的计划开始整体平移日期，不复制基线与 AI 报告。
- 「版本更新」新增本次记录。功能边界见 [功能说明](../../../docs/features.md)。
- 无数据库结构变更：只新增接口，沿用现有表；启动时 `create_all` 无新表。

| 项目 | 实际值 |
|---|---|
| 新镜像 | `mb-pm:structure-edit-20261013T160437Z` |
| 镜像 ID | `sha256:63e694ac4fb7b71fb5eeef902922c84dc34ec52b50015c3a125dfa275a973abb` |
| 回滚镜像 | `mb-pm:kb-root-20261006T072035Z` |
| Git | 分支 `feat/project-structure-edit`，提交 `36afbc0`（工作区干净，构建输入由 `git archive` 导出） |
| 构建输入 | 服务器 `releases/structure-edit-20261013T160437Z/`，210 个文件，SHA256 见 `source-state.json`，上传后逐一核对一致 |
| 备份 | 服务器 `private-config-backups/structure-edit-20261013T160437Z/`：`pms.dump`（已验证可读取）、`.env`、三份 Compose、直连 Caddyfile、前一镜像 |
| 重建容器 | 仅 `mb-pm-v2-app-1` 与 `mb-pm-v2-app-direct-1`（两者共用 `PMS_IMAGE_TAG`）；数据库、IAM、隧道、直连代理未动 |

首次构建 `structure-edit-20261013T155819Z` 在候选核对前发现问题（见下文）后被替换，其镜像与解包目录已删除，备份目录保留，未曾上线。

## 已验证

- 本地：后端 166 项测试分别在 SQLite 与临时 PostgreSQL 18.4（与生产同版本）上通过；TypeScript / Vite 构建、变更文件 ESLint 通过；浏览器中用复制出的测试项目走通编辑模式（新增 / 修改 / 删除、日期冲突提示、删除保护、版本冲突与重新载入、离开确认）和复制项目，测试数据已清理。
- **候选核对（生产库副本）**：在 `pms-db` 中用本次 `pms.dump` 建副本库，以新镜像启动候选容器（仅接内部网络、无端口），在容器内直接调用新服务函数（`candidate-validation.json`）。CMB820（2 个子项目、33 个任务、7 个里程碑、38 条依赖）原样保存零改动（任务逐字段一致、结构版本与汇总不变）；新增再删除任务后任务数据复原；复制项目数量一致、执行数据全部重置、里程碑工时保留。候选日志无错误。候选容器、副本库与临时环境文件已删除。
- 候选核对前在种子数据上发现：原样保存会把从 1 开始的子项目排序号重编为从 0 开始（结构版本因此变化，会打断他人编辑），并对所有子项目重算进度。已在 `36afbc0` 修复（保留原排序号；只重算任务有增减的子项目）并补测试后重新构建。
- 正式服务：`app`、`app-direct` 约 14 秒后 healthy；本机 `/health`、公网 `pm.openlims.ai/health` 正常；`www` 登录 / 帮助、`pm` 页面 200；`release-notes.html` 200 且含新记录；匿名访问 `auth/me`、`portal/me`、结构接口、复制接口均为 401；线上前端包含「复制项目」；`direct_entry.py check` 通过；切换后应用日志无错误。
- 服务器访问 Cloudflare 边缘时仍偶有超时（与 [IP 直连应急入口](../README.md#ip-直连应急入口2026-10-13-起) 所述线路问题相同），从外部网络访问各公网地址正常。

**待完成：** 客户账号在线上实际使用编辑模式与复制项目（注意：复制会在生产库新建真实项目，验证后可在项目详情右上角删除）。

## 同日运维变更（2026-10-13 晚）

Cloudflare 隧道 `Maibo-pm` 晚高峰离线：服务器到 Cloudflare 的线路丢包、UDP（QUIC）被阻断。已将 `cloudflared` 改为只走 TCP（`--protocol http2`），并新增 IP 直连应急入口 `https://36.154.190.9:8443`（IAM `:18443`，自签名证书，与域名入口共用数据库和 IAM）。启停与核对方法见 [IP 直连应急入口](../README.md#ip-直连应急入口2026-10-13-起)。

## 回滚

在 `/home/prometheus/mb-pm-v2` 将 `.env` 的 `PMS_IMAGE_TAG` 改回 `kb-root-20261006T072035Z`，然后：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
```

不回退数据库、不整份恢复旧 `.env`。旧镜像没有编辑模式与复制项目；回滚前用新功能做出的修改与复制出的项目会保留在库中，旧版可正常显示。
