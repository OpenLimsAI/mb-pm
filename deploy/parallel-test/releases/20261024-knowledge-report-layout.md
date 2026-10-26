# 知识报告名称与面板布局 · 2026-10-24

本次更新已上线的知识报告应用，统一名称并调整资料与 AI 助手的独立隐藏/展开布局。正式入口：[知识报告](https://www.openlims.ai/solutions)。首版此前已随 [10 月 23 日信息获取真实服务](20261023-information-live.md) 整包上线。

## 源码与范围

- [PR #40](https://github.com/OpenLimsAI/mb-pm/pull/40) 与连接提示补全 [PR #41](https://github.com/OpenLimsAI/mb-pm/pull/41) 均在全部 5 项检查通过后 squash merge；发布固定 main 提交 `7afebf3c0fc9aa99c6cfc3e79f1281cc0a39cc8c`。
- 应用名称统一为「知识报告」，同步工作台、页签、撰写、评审、导出和连接提示；保留 `/solutions`、接口、存储标识以及用户自定义标题和正文。
- 右侧资料和 AI 助手分别隐藏/展开；同时展开时上下排列，只展开一个时填满右侧剩余高度，隐藏区保留紧凑恢复入口。报告、检索和问答状态保持。
- 更新静态页面及三个后端文件中的中文称谓：`app/services/solutions.py`、`app/schemas/solution.py`、`app/services/solution_knowledge.py`。无数据库结构迁移，不改变权限、检索和模型业务逻辑，不更新知识库应用。

## 发布与验证

| 项目 | 结果 |
| --- | --- |
| 发布时间 | `2026-10-24T15:09:11.831500+00:00`；2026-10-24 11:09:11（America/New_York） |
| 当前镜像 | `mb-pm:knowledge-report-20261024T150700Z` |
| 镜像 ID | `sha256:a9441444a3ef849c0ef22f34d79c2a0bd7b72ecfe4b1a7a3828dd3d69929dbc8` |
| 回滚镜像 | `mb-pm:information-live-20261023T181528Z` |
| 更新服务 | `app` / `app-direct`，两个实例均 healthy |
| 源码与回执 | `/home/prometheus/mb-pm-v2/releases/knowledge-report-20261024T150700Z/` |
| 私有备份 | `/home/prometheus/mb-pm-v2/private-config-backups/knowledge-report-20261024T150700Z/` |

- 本地前端 127 项测试及覆盖率门槛、类型检查、生产构建与 lint 通过；后端 22 项报告测试、54 项知识适配测试通过。
- 候选容器无网络、无挂载，使用虚拟 IAM 配置；3 项候选检查通过。这些检查不代表真实 IAM 登录验收。
- 生产静态页面与后端共 161 个文件的哈希和候选一致；全部后端文件与固定源码一致。相对前一镜像，仅上述三个后端文件的中文称谓改变。
- 服务器内部两个实例的健康、页面及匿名鉴权检查通过：健康接口返回 200，`/solutions` 返回 200，匿名 `/api/v1/solutions` 返回 401。
- 公网 HTTPS 复查受网络连接超时阻断：服务器、本地命令行与内置浏览器均未完成连接。本次不能记录为公网验收通过；公网和真实用户登录仍待验收。
- 两个应用实例的环境变量与挂载保持不变，Compose 文件保持不变；服务器 `.env` 仅修改 `PMS_IMAGE_TAG`。其他 11 个容器 ID 保持不变。
- PM 数据库已执行 `pg_dump`，并通过 `pg_restore --list` 验证备份可读；同目录保留原环境、Compose 及容器 inspect 回执。本次没有执行业务数据切换前后哈希比较，不能据此宣称全部业务数据已逐项校验。

## 配置与验收边界

知识报告页面和后端名称更新已部署。生产 `SOLUTION_KB_CORE_URL`、`SOLUTION_KB_TOKEN`、`SOLUTION_KB_PUBLIC_URL` 仍未配置，因此本应用尚不能检索企业论文，界面明确提示知识库连接未配置。本次没有注入或复制 Core 令牌。

现有 AI 配置存在并保持不变，但本次未执行模型连通性或效果验收。AI 配置缺失时提供明确标注的资料检索；已配置但调用失败时显示错误。这与企业知识连接未配置是两个独立状态。

客户本人登录后的报告保存、资料引用、问答、评审、导出及面板状态恢复仍待使用验收。服务器内部页面、匿名接口及隔离候选检查不能代替公网和真实用户验收；没有借用客户会话写入测试业务数据。

## 回滚

将服务器 `PMS_IMAGE_TAG` 恢复为 `information-live-20261023T181528Z`，使用现有 `compose.yml` 与 `compose.production.yml` 仅重建 `app`；直连实例加现有 `compose.direct.yml` 仅重建 `app-direct`，随后复查健康、入口及匿名鉴权。

保留当前数据库、知识库与信息获取原文卷、AI 设置及运行配置，不执行全栈 down，不删除卷，不用旧数据库覆盖上线后数据。前一镜像恢复旧名称和布局，但保留原应用路径及已有业务记录。备份与源码回执位置见上表。
