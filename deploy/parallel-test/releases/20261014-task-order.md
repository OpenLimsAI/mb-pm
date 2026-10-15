# 任务插入与手动排序上线记录

日期：2026-10-14 01:29（Asia/Taipei，即 2026-10-13T17:29Z）。已部署到 `pm.openlims.ai`（同时更新 IP 直连应急入口）；客户账号的真实操作验收待完成。

## 发布内容

- **任务插入与手动排序**（项目编辑模式与模板结构编辑相同）：任务行上沿的「＋」可在任意两个任务之间插入（不预设前置依赖；项目中开始日期默认接在上一个任务之后）；拖动行左侧手柄调整顺序，可跨子项目，选中手柄后可用 ↑ ↓ 键移动；编辑 / 新建任务时「前置依赖」默认展开。WBS 树形、表格录入、甘特图都按这一手动顺序显示。
- **版本更新页**：页首新增「最近更新」，由 `notes.json` 最新记录自动生成；页首标签与导航指向它。
- **缓存**：`index.html`、`release-notes.html` 等文件名不带哈希的页面返回 `Cache-Control: no-cache`，`/assets` 下带哈希的文件为长期缓存；应用内版本更新页的嵌入地址带构建号。此前发版后浏览器可能按启发式缓存继续显示旧页面。
- **数据库**：`tasks` 新增可空列 `sort_order`（启动时 `_ensure_schema` 添加）。没有顺序号的任务在启动时按原显示顺序（计划开始、编号）补号，不改 `updated_at`；AI 分析数据指纹不包含该列。

| 项目 | 实际值 |
|---|---|
| 新镜像 | `mb-pm:task-order-20261013T172607Z` |
| 镜像 ID | `sha256:82ad5b1161fadc59e47ad202163affdcbe004b40b4e737fd3f456b40cfb812b1` |
| 回滚镜像 | `mb-pm:structure-edit-20261013T160437Z` |
| Git | 分支 `feat/project-structure-edit`，提交 `937d534`（工作区干净，构建输入由 `git archive` 导出） |
| 构建输入 | 服务器 `releases/task-order-20261013T172607Z/`，213 个文件，SHA256 见 `source-state.json`，上传后逐一核对一致 |
| 备份 | 服务器 `private-config-backups/task-order-20261013T172607Z/`：`pms.dump`（已验证可读取）、`.env`、三份 Compose、直连 Caddyfile、前一镜像 |
| 重建容器 | 仅 `mb-pm-v2-app-1` 与 `mb-pm-v2-app-direct-1`；数据库、IAM、隧道、直连代理未动 |

## 已验证

- 本地：后端 173 项测试分别在 SQLite 与临时 PostgreSQL 18.4 上通过；构建、变更文件 ESLint 通过；浏览器中用复制出的测试项目验证插入、拖动、键盘移动与保存后三个视图的顺序，模板编辑器验证插入与拖动（未保存），测试数据已清理。另在临时 PostgreSQL 上模拟升级前表结构，确认加列、补号且 `updated_at` 不变。
- **候选核对（生产库副本）**：用本次 `pms.dump` 建副本库，新镜像候选容器启动时完成加列与补号（2 个子项目、33 个任务，顺序与原显示顺序一致，`updated_at` 全部不变）。升级前用旧镜像、升级后用新镜像计算 AI 数据指纹，结果相同（唯一一份已有报告在升级前已因数据变化显示过期，升级不改变其状态）。原样保存零改动；中间插入、调整顺序、复制保留顺序均正确；缓存头符合预期；候选日志无错误。候选容器、副本库与临时环境文件已删除。
- 正式服务：`app`、`app-direct` 约 14 秒后 healthy；生产库加列与补号完成（33 个任务无空值）；公网健康检查正常，`www` 登录 / 帮助、`pm` 页面 200；版本更新页含「最近更新」与新记录且为 `no-cache`；带哈希的 JS 为长期缓存；线上前端包含插入与拖动；匿名接口 401；`direct_entry.py check` 通过；切换后应用日志无错误。

**待完成：** 客户账号在线上实际使用插入与拖动排序。本次之前已打开过应用的浏览器，如仍显示旧页面，强制刷新一次即可（Windows `Ctrl+F5`，macOS `Cmd+Shift+R`）。

## 回滚

在 `/home/prometheus/mb-pm-v2` 将 `.env` 的 `PMS_IMAGE_TAG` 改回 `structure-edit-20261013T160437Z`，然后：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
```

不回退数据库、不整份恢复旧 `.env`。旧镜像不使用 `sort_order` 列，该列保留无影响；旧版 WBS 视图恢复按计划开始日期排列。
