# 知识库统一模型接口

知识库与工作台共用组织模型配置及默认选择。环境发布状态与验收边界见[发布契约](../deploy/parallel-test/releases/20261104-knowledge-unified-ai.md)。共享配置由工作台 `/model-settings` 管理，使用 `organization_ai_settings` 表按已验证的 `(issuer, organization)` 加密保存。旧 `solution_ai_settings` 个人配置保留且不自动公开，详见[组织共享 AI 设置](shared-ai-settings.md)。本轮为本地开发，尚未部署。知识库服务端取得模型目录和生成结果，无法取得模型密钥或改变模型服务地址。

## 身份与配置

`KNOWLEDGE_AI_ENABLED=false` 默认关闭。启用集成时，还需设置 `KNOWLEDGE_AI_CLIENT_ID` 为知识库自己的独立 OIDC client ID，并启用已确认的 `OIDC_GLOBAL_LOGOUT_ENABLED`、`CASDOOR_ACCOUNT_STATUS_VISIBLE`。未配置、状态检查关闭或状态字段未确认均返回 503。

接口只接受知识库服务端转发的当前用户 `Authorization: Bearer <access JWT>`。PM 验证签名、issuer、知识库专用 audience、有效期与主体，再实时向 IAM 校验 token 的 `client_id/sub`、账号状态、当前角色和密码状态；访问须具有当前 `kb_viewer`、`kb_editor` 或 `kb_manager` 角色。无需绑定 PM 业务成员。现有 PM／门户接口继续拒绝知识库受众，不接受浏览器自报 actor、账号或跨域 cookie 代替身份。

知识库必须通过共享运行时公开的 session validator 取得本请求已核验身份；后台生成、工具后续轮与上下文压缩每轮都重新校验会话及最初 `authenticatedAt`，不能仅保存创建任务时的 JWT。access token 不进入前端 JSON、URL、日志、模型上下文或任务元数据。PM 不信任调用方自填的认证时间。两端还需具备 IAM 跨客户端 introspection 能力与正确 JWKS；能力不符时失败关闭，不转移知识库 client secret。

知识库仍负责每个功能、文献和工具的授权。模型网关不检索文献、不执行模型请求的工具，不替代知识库的编辑／管理权限。

## 模型目录

`GET /api/v1/integration/knowledge/ai/models` 返回：

```json
{
  "models": [
    {"id":"shared:profile-1","name":"共享研究模型","provider":"deepseek","model":"configured-model","key_set":true,"available":true},
    {"id":"system","name":"工作台系统默认","provider":"deepseek","model":"configured-system-model","key_set":true,"available":true}
  ],
  "default_model_id":"shared:profile-1",
  "revision":1,
  "settings_url":"https://www.example.test/model-settings"
}
```

目录没有 `api_key` 或 `base_url`。默认选择与工作台同一份组织共享配置一致；`system` 兼容选择解析为该组织共享默认。共享配置不存在、缺密钥、被删除或上游失败时明确报错，不借用其他组织或成员的模型密钥。目录与修订号共享，会话和知识库资料权限仍按当前用户验证。

## 单轮生成与工具

`POST /api/v1/integration/knowledge/ai/chat/completions` 接受非流式 OpenAI 格式。`model` 是上面返回的共享配置 ID 或 `system`，不是供应商模型名称；省略时使用当次工作台默认配置。可选 `settings_revision` 不匹配时返回 409。真实供应商、地址和密钥均由 PM 当前配置解析，输入不允许这些字段或 actor。

支持文本 `messages`、`tools`、`tool_choice`、`parallel_tool_calls`、`response_format`、有限采样选项及输出预算。assistant 的 `tool_calls` 与相应 tool 消息必须成对；支持供应商后续工具轮需要的 `reasoning_content`。该字段只供服务端继续工具对话，不应用作用户可见正文。返回 OpenAI `choices`、`finish_reason`、工具调用和有报告的 `usage`。知识库的共享 Agent 继续负责工具执行、任务事件与 NDJSON 输出。

- 请求最多 1 MiB、128 条消息、32 个工具；单条文本／工具参数／reasoning 最多 200,000 字符，文本分段最多 64 项，JSON 嵌套最多 32 层。
- `max_tokens` 或 `max_completion_tokens` 二选一，上限 65,536，默认 8,192。Kimi 沿用工作台采样与输出参数规则，上限 16,384；功能层仍需分段翻译，并处理 `finish_reason=length`。
- 上游使用既有 DNS 固定、安全地址审批、不使用环境代理、不跟随重定向的连接；单轮 120 秒，响应最多 2 MB。
- 共享翻译通常按 12 个段落／4,000 字符分批；单个超长段落仍单独生成。统一非流式入口不沿用旧翻译流式连接的长等待时间，超长段落或慢模型可能触发 120 秒超时，保留已保存结果并明确失败。
- 接口不提供上游 token 流，`stream=true` 返回 422。工具回合和上下文压缩仍可通过多次非流式调用执行，应用任务事件流由知识库保留。
- 系统默认 Ollama 转换为原有 `/api/chat` 协议；其特定强制工具选择不支持时返回 422，不悄悄忽略。

模型验证或供应商错误只返回固定安全说明，生成请求带 `X-Assistant-Diagnostic-ID`，分类错误带 `X-Assistant-Error-Code`；不回显输入、上游异常、配置对象或凭据。usage 仅代表供应商报告的 token 数，缺失时为空，未新增统一计费或金额账本。

## 验证

合成测试使用自签 OIDC JWT、假的实时 IAM 状态和假的模型响应，不访问真实用户、知识库或付费模型：

```sh
cd backend
python -m pytest -q tests/test_knowledge_ai_gateway.py tests/test_solution_ai.py tests/test_solution_ai_transport.py tests/test_model_network_policy.py tests/test_oidc_status.py tests/test_request_limits.py
```

覆盖身份／受众隔离、当前角色和密码失效、共享默认与显式系统选择、设置变更、工具往返、压缩／翻译文本、Ollama 转换、请求大小、凭据和错误脱敏。真实环境启用前核对精确知识库受众、实时 IAM 状态校验与配套知识库运行时；测试结果不代替客户账号和真实供应商验收。

定点及全量回归覆盖统一模型与笔记接口；配套知识库 `tests/e2e/workspace-ai.spec.ts` 用合成 HTTP 验证普通用户统一入口无密钥框、模型选择传到问答请求、页面重新获得焦点时同步默认模型，以及换账号／会话结束后的选择隔离；未调用真实模型。桌面和窄屏界面已保存本地截图检查。
