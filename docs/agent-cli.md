# 迈博 Agent 命令行与 MCP

外部 Agent 通过业务 API 读取当前用户可见的项目、任务、基线和逾期风险报告。查询结果由迈博生成并按项目与任务权限过滤。风险报告带有审核链接时，用户可以在已登录的项目页面查看并确认保存。

## 准备

使用 Python 3.9 或以上版本。部署方需按 [Agent 接入配置](configuration.md#agent-业务接口) 启用业务接口。运行环境需要能访问迈博地址。

向命令行或 MCP 进程提供两个环境变量。

| 变量 | 值 |
| --- | --- |
| `MAIBO_AGENT_BASE_URL` | 迈博服务的源地址，例如 `https://pm.example.com`。本机测试也可使用回环 HTTP 地址。 |
| `MAIBO_AGENT_TOKEN` | IAM 为当前用户签发的专用 Agent 委托访问令牌。 |

通过运行环境的密钥注入提供令牌。令牌到期后更新环境变量并重启客户端。命令行参数、Codex 配置文件和聊天内容不存放令牌值。

## 命令行查询

在仓库根目录运行这些查询命令。

```sh
python3 scripts/maibo-agent.py projects --page 1 --page-size 20
python3 scripts/maibo-agent.py tasks --project-id PROJECT_ID --overdue
python3 scripts/maibo-agent.py task TASK_ID
python3 scripts/maibo-agent.py baseline TASK_ID
python3 scripts/maibo-agent.py baseline TASK_ID --baseline-id BASELINE_ID
python3 scripts/maibo-agent.py risk-report PROJECT_ID
```

省略 `--project-id` 时，任务查询覆盖当前用户可见的项目。省略 `--overdue` 时，包含所有逾期状态。使用 `--no-overdue` 查询非逾期任务。分页从 1 开始，每页最多 50 条。

成功时标准输出为 UTF-8 JSON。配置或查询失败时，退出码为 1，标准错误包含错误代码、说明和可用的 HTTP 状态码。

## 在 Codex 中使用

在 Codex 的配置中添加下列设置，将脚本路径换成实际绝对路径。启动 Codex 的环境应当已经提供上述变量。

```toml
[mcp_servers.maibo]
command = "python3"
args = ["/absolute/path/to/mb-pm/scripts/maibo-agent.py", "mcp"]
env_vars = ["MAIBO_AGENT_BASE_URL", "MAIBO_AGENT_TOKEN"]
```

重新打开 Codex 后，可以让它“列出我能看到的项目，再按项目生成逾期风险报告”。工具名为 `projects`、`tasks`、`task`、`baseline` 和 `risk_report`。报告带有 `review_url` 时可打开该链接，在迈博中确认保存。其他支持本地 MCP stdio 的客户端也可使用同一启动命令。配置字段和通信格式可参阅 [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 和 [MCP stdio 协议](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

## 本地验证

```sh
python3 backend/tests/test_agent_transport.py
```
