# 项目 AI 助手简化交互 · 生产发布记录（2026-11-15）

已随包含 [PR #214](https://github.com/OpenLimsAI/mb-pm/pull/214) 和[笔记统计 PR #215](https://github.com/OpenLimsAI/mb-pm/pull/215) 的固定 main，于 2026-11-15 10:54 SGT 完成同一次生产发布。本记录补充助手交付范围，不触发重复部署。

## 变化与固定版本

- 一个输入框、一次发送、三个常用提示，历史按需展开；明确请求直接处理，范围有歧义时才补充。
- 工作重点和延期任务按事实规则查询；会议原文、历史实际范围与日期可完整重用，周报草稿可本地编辑、复制及导出。
- 保留旧链接、分析依据、任务未保存保护和修改预览确认；迟到响应不覆盖新问题，旧排期确认不冒充本次新要求。
- PR #214 最终 head `ba731315981217883db4a67006208a64e3f76bd6` 的七项检查全部成功后 squash 为 `b634caee21f9bffa58a62293679704f36d0ae63b`。首轮 PostgreSQL 检查发现测试样本 ID 超过字段长度，缩短样本后重新通过，未以跳过测试处理。
- `b634caee` 两次备份保护中止，均未切换生产；后续 main `61a85ab` 保留本次 20 个专用文件的完整 Git blob 和模式，再一次发布两项改造。最终 main 的[CI](https://github.com/OpenLimsAI/mb-pm/actions/runs/43656893166)及[安全检查](https://github.com/OpenLimsAI/mb-pm/actions/runs/43656893227)共七项全部成功。

| 项目 | 固定值 |
| --- | --- |
| 运行源码 | `61a85ab974f82740da6dde34b5bb1c2a4cbe2dbc` |
| Git tree | `d387fe62f181689ea9564b1ec207ed76446e41b8` |
| 正式镜像 | `sha256:5d285179b3e14e4e94a3d5647ab650b8b07411c65091b4fe6456550c6292be46` |
| 镜像标签 | `mb-pm:note-category-counts-20261115-61a85ab` |
| 源码归档 SHA256 | `a9374fe68d34fbdecb59e13050d26ed4364b03d714c8a5a53ceee6eb0200a6a5` |
| 构建清单 SHA256 | `f80740e14502559ee3d3b648472c2283312fd9f071e27a4c032d46bb5d44e6aa` |
| 部署清单 SHA256 | `5b2f5d914a87f50e64957ef2a2a6f408775198cab6dfbf38860bc0ca9fb42b52` |

## 验证、备份与切换

- 本地固定源码通过前端 163 文件 / 1352 项、后端专项 64 项、类型检查、修改文件 lint、生产构建及入口 guard；助手专项覆盖单次发送、旧链接、历史与新问题隔离、长会议原文、范围/日期重用、周报编辑和旧排期回执恢复。桌面、320px 周报及深色界面使用合成数据核对。

- 服务器逐项核对 1250 个 Git blob 及文件模式。相对在位基线，后端仅变化 `app/services/pm_ai_agent.py`、`app/services/pm_ai_triage.py` 和笔记统计的 `app/api/v1/notes.py`；正式镜像摘要与固定源码一致，运行依赖和迁移文件保持一致。

- 本次加密在线备份覆盖 3 个 PostgreSQL、21 处持久挂载及 12 个 SQLite，SHA256 为 `47667b4346811c222eeb26b22faee140a3b578f23ce3d7ea8e72730b23861382`。隔离恢复验证通过并清理临时资源，报告 SHA256 为 `182bf7bb229a49d44dd827a546d486d7bc43b44ae337464acc6404203131c0ef`；未向生产恢复数据，未停止业务写入，不宣称跨存储的全局原子快照。

- 正式镜像完成两个全新合成认证候选及同卷重启验收，覆盖匿名拒绝、身份隔离、共享模型配置和持久化；另有笔记统计的隔离 PostgreSQL 与浏览器验收。无生产数据挂载或付费模型调用；这些候选检查不代表新版项目助手所有业务场景均已人工验收。

- 官方 Trivy 漏洞库更新于 `2026-11-15T01:07:39.649898+00:00`，离线扫描绑定正式镜像配置和层摘要，可修复 HIGH/CRITICAL 发现为 0；扫描报告 SHA256 为 `46404e380a80a56dd73d58b0143ff72fa619faf38c4aecc9a32312540cbc8e49`。

- `app`、`app-direct` 均运行上述镜像且 healthy。完整 Compose 链 43→44，原 43 份顺序保留；沿用私有运行配置、密钥、模型设置、数据卷及 worker 开关，其他生产服务保留。

- 数据库 68 表结构及账本 `019` 保留，未执行结构迁移、初始化或生产数据库恢复。切换后独立复核双实例的两个助手后端源码摘要和构建清单一致。

- 共同发布的 20 项公网检查通过。助手另行复核 `www.openlims.ai`、`pm.openlims.ai` 的健康、匿名身份接口 401、固定源码/清单、启动及项目详情资源摘要和新助手分块。首页仅剔除已核对的 Cloudflare beacon 与插入换行后比较，不关闭 TLS 或安全策略。

## 验收边界与回退

真实客户账号下的新版助手完整交互、业务写入和付费模型生成尚未验收。合成模型、单元测试、候选认证和公网静态产物核对不能代替这些业务验收；本次未修改客户模型配置或为验证发起收费请求。

共同发布根为 `/home/prometheus/mb-pm-v2/releases/note-category-counts-20261115-61a85ab`。使用其受保护回退记录和完整原始 Compose 链，回退镜像为 `sha256:61c97aaddef8d16ecf9f5cbccf3500230af688a373d7b9f10fb6026515093a89`，旧源码为 `a829b9ced9b2e1f6a94ee9d1798f20d638de8979`。回退前重新核对在位版本、活动任务及发布/备份锁；仅回退受影响的镜像和部署覆盖，不恢复旧库或整份旧环境文件，不覆盖新增业务记录及同期独立服务更新。后续版本已发布时重新审核回退依据。

脱敏核验材料位于维护工作区 `local-development/2026-11-15-project-assistant-simple-release/` 的 `combined-evidence/`、`combined-live-verification.json`、`public-verification.json`、`combined-main-inheritance.json` 及 CI/本地测试记录。笔记任务维护同一次发布的部署交接；本记录为纯文档补充。
