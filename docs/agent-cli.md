# 迈博 Agent 命令行与 MCP

外部 Agent 使用当前用户的权限查询项目、任务、基线、台账、知识来源和变更记录。Agent 可模拟排期并创建变更提案；用户在迈博看到影响并确认后，系统才会执行。CLI、MCP 和其他 API 客户端调用同一组业务接口。

## 准备

使用 Python 3.9 或以上版本。部署方需按 [Agent 接入配置](configuration.md#agent-业务接口) 启用业务接口。运行环境需要能访问迈博地址。

向命令行或 MCP 进程提供两个环境变量。

| 变量 | 值 |
| --- | --- |
| `MAIBO_AGENT_BASE_URL` | 迈博服务的源地址，例如 `https://pm.example.com`。本机测试也可使用回环 HTTP 地址。 |
| `MAIBO_AGENT_TOKEN` | IAM 为当前用户签发的专用 Agent 委托访问令牌。 |

通过运行环境的密钥注入提供令牌。令牌到期后更新环境变量并重启客户端。命令行参数、Codex 配置文件和聊天内容不存放令牌值。

## 命令行与工具

在仓库根目录运行这些查询命令。

```sh
python3 scripts/maibo-agent.py projects --page 1 --page-size 20
python3 scripts/maibo-agent.py tasks --project-id PROJECT_ID --overdue
python3 scripts/maibo-agent.py task TASK_ID
python3 scripts/maibo-agent.py baseline TASK_ID
python3 scripts/maibo-agent.py baseline TASK_ID --baseline-id BASELINE_ID
python3 scripts/maibo-agent.py risk-report PROJECT_ID
python3 scripts/maibo-agent.py project-context PROJECT_ID
python3 scripts/maibo-agent.py tasks --project-id PROJECT_ID --owner-id USER_ID --due-to 2026-11-13
python3 scripts/maibo-agent.py register PROJECT_ID --kind risk
python3 scripts/maibo-agent.py schedule-preview PROJECT_ID --task-id TASK_ID --delay-workdays 3
python3 scripts/maibo-agent.py propose PROJECT_ID --request-id delay-review-001 --reason '实验延期' \
  --action '{"kind":"schedule","task_id":"TASK_ID","delay_workdays":3}'
python3 scripts/maibo-agent.py proposals PROJECT_ID
python3 scripts/maibo-agent.py proposal PROPOSAL_ID
python3 scripts/maibo-agent.py start-analysis PROJECT_ID --request-id weekly-001 \
  --focus '本周逾期和受阻任务' --allow-model-processing
python3 scripts/maibo-agent.py analysis-job PROJECT_ID JOB_ID
python3 scripts/maibo-agent.py analysis-result PROJECT_ID JOB_ID
python3 scripts/maibo-agent.py knowledge-search --q '稳定性试验 SOP'
python3 scripts/maibo-agent.py knowledge-read --source-id SOURCE_ID
python3 scripts/maibo-agent.py changes PROJECT_ID --kind delay --days 7
```

省略 `--project-id` 时，任务查询覆盖当前用户可见的项目。省略 `--overdue` 时，包含所有逾期状态。使用 `--no-overdue` 查询非逾期任务。项目和任务查询分页从 1 开始，每页最多 50 条。任务详情包含依赖、活动、交付物元数据和验收要求；只返回可见的关联记录。

成功时标准输出为 UTF-8 JSON。配置或请求失败时，退出码为 1，标准错误包含错误代码、说明和可用的 HTTP 状态码。`--action` 是 JSON 对象，`--locked-ids` 是 JSON 数组。命令帮助和 MCP 工具清单列出参数。

## 核对和执行提案

1. 用 `project-context` 和 `task` 确认可用操作及对象编号。任务操作使用详情中的 `revision`，排期可先用 `schedule-preview` 查看依赖影响、里程碑变化和冲突。
2. 用 `propose` 创建提案。支持 `schedule`、`create_task`、`update_progress`、`reassign_task`、`register_risk`、`attach_deliverable`、`submit_acceptance`。关联交付物时提交已有文档的链接，迈博在确认后创建版本记录；提交验收后由指定验收人处理。
3. 打开返回的 `review_url`，用创建提案的同一账号登录，核对变更前后内容并确认。系统重新校验权限、版本和影响，项目数据变化时需要重新预览。
4. 用 `proposal` 查看状态与执行回执。提交时保留自己的 `request_id`：同一请求超时可用原编号重试；查询到已执行时以原回执为准。用 `cancel-proposal` 撤销未执行提案。仅在状态及操作类型允许时用 `retry-proposal --request-id NEW_REQUEST_ID` 生成新提案，再由用户确认。

风险报告通过审核链接进入「项目 AI 助手 → 综合评估」，确认后保存在原项目报告历史。提案核对链接统一打开助手内的「建议核对」；旧 `tab=ai` 链接仍兼容。

后台项目分析由有权限的项目管理人员发起。经用户同意后，迈博把项目计划、任务备注、依赖和团队名称等所需信息交给已配置的模型。保存返回的任务编号，用 `analysis-jobs`、`analysis-job` 和 `analysis-result` 找回状态与结果。`cancel-analysis` 可取消等待或处理中的任务；`retry-analysis` 用新请求编号重试允许重跑的任务，需要再次明确同意模型处理。

## 知识原文和项目订阅

`knowledge-search` 使用当前账号在独立知识库的权限。结果含来源、版本、片段及可用的元数据。`knowledge-read` 读取当前版本的正文文本，并以返回的 `next_offset` 和 `source.version` 续读；位置单位为 UTF-16。版本变化时，重新检索或从新版首段读取。访问需启用现有知识源连接并为账号授予知识库角色。

`changes` 是轮询订阅。首次请求指定历史天数和可选事件类型，保存 `next_cursor`；后续带同一项目和类型的游标继续读取。`has_more` 为真时可立即读下一页；读完可按业务需要定时轮询。使用事件 `id` 去重。`delay` 指记录中的计划结束日期后移或标记延迟，另可读取 `deliverable`、`approval`、`task_update`。新增授权后可从所需历史范围重新开始读取；接口每次按最新权限过滤。游标闲置 30 天后需重新开始。该接口返回数据供 Agent 跟进，订阅运行频率由调用端决定。

## 在 Codex 中使用

在 Codex 的配置中添加下列设置，将脚本路径换成实际绝对路径。启动 Codex 的环境应当已经提供上述变量。

```toml
[mcp_servers.maibo]
command = "python3"
args = ["/absolute/path/to/mb-pm/scripts/maibo-agent.py", "mcp"]
env_vars = ["MAIBO_AGENT_BASE_URL", "MAIBO_AGENT_TOKEN"]
```

重新打开 Codex 后，可以让它“列出本周逾期任务，核对进展和风险台账，模拟把稳定性试验延后三个工作日，给我核对链接”。MCP 工具对应上面的命令，名称中的连字符换成下划线，例如 `schedule_preview`。其他支持本地 MCP stdio 的客户端也可使用同一启动命令。配置字段和通信格式可参阅 [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 和 [MCP stdio 协议](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

## 本地验证

```sh
python3 backend/tests/test_agent_transport.py
(cd backend && python -m pytest -q tests/test_agent_projects.py tests/test_agent_context.py tests/test_agent_actions.py tests/test_agent_knowledge_events.py)
```

统一本地版本的业务迁移链为 `027 → 028`（项目 AI 运行与回执）`→ 029`（Agent 提案与回执）`→ 030`（事件顺序）。原来未发布 Agent 分支中的 `028/029` 已顺延，避免与项目 AI 的 `028` 重号。已有数据库先核对迁移账本与实际表，在备份副本上验证后再使用 `alembic upgrade 030`；历史 `007` 分支保持原样。不能把旧 Agent 分支的 `028/029` 账本直接当作本链的相同版本，也不能只修改账本来跳过升级。空库沿用应用的现有建表流程；早期迁移 `018` 依赖应用已补齐的任务成本列。部署后另用真实 IAM 和知识库账号验收授权及读写范围。

项目 AI 上下文、待办优先级和 Agent 查询共用逾期口径：计划完成日期早于业务日期，状态尚未完成或验证；普通任务还须完成度不足 100%，里程碑则须状态完成。“标记延迟”“阻塞”和即将到期分别保留，不等同于已逾期。
