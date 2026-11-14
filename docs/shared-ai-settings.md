# 组织共享 AI 设置

这是独立于笔记修复的本地开发变更，尚未部署或完成真实供应商验收。

工作台 `/model-settings`、AI 助手、研究报告和知识库使用同一组织的模型列表、默认模型和修订号。界面仍调用 `GET/PUT /api/v1/solutions/ai/settings`，响应仍是 `{profiles, default_profile_id, revision}`；知识库继续通过既有受保护模型网关读取目录和生成结果。

## 保存与兼容

共享配置使用 `organization_ai_settings`，以已验证的 `(issuer, organization)` 为键，配置及密钥由 `APP_SECRET` 加密保存，并使用修订号比较更新。成员并发编辑时，旧修订保存返回 409，保留当前窗口的草稿，不能覆盖另一位成员的新设置。读取仅返回 `key_set`，不回显密钥。

新共享目录的配置 ID 使用 `shared:` 前缀，与历史个人模型 ID 区分；原接口的 `system` 兼容选择解析为同一个组织共享默认模型。更改模型配置不会把个人任务、对话、笔记或资料权限改为共享。登录、后台任务发起人和知识库会话仍分别验证，浏览器模型选择缓存仍按身份隔离。

项目管理 `/ai-settings` 跳转「项目 AI 助手 → AI 设置」（`/project-assistant?assistant=settings`），保留分析提示词和原有访问权限。分析提示词、备用模型开关与模型目录保存在同一组织密文记录中，以同一修订号原子保存；旧文件只作为初次导入来源，运行期不再向旧文件写配置。旧入口提交必须携带读取时的 `revision`，过期或缺失返回 409，不能覆盖其他成员的修改。仅修改提示词时使用兼容接口的 `preserve_shared_models=true`，不写模型条目或切换共享默认；即使当前默认为 OpenAI、GLM 或自托管模型，旧页面也能显示该默认并安全保存提示词。完整共享模型管理使用 `/model-settings`。

旧 `solution_ai_settings` 的个人配置及密文保留，不自动加入组织共享目录，也不批量公开历史个人密钥。历史模型引用继续依照原有个人身份解析。知识库只在明确恢复旧无前缀模型 ID 时，通过受保护的 `legacy_profile_id` 定点查询本人旧配置；普通共享目录不列出个人配置，也不向其他成员开放。此轮不新增 AI 权限分配功能。

支持现有云服务和 OpenAI 兼容服务；Ollama 使用服务根地址、不要求 API 密钥。自托管地址仍受服务器 `AI_ALLOWED_INTERNAL_ORIGINS` 批准及既有网络安全校验约束，不因增加共享模型而放宽。Ollama 不显示未经核实的供应商价格。

## 旧知识库 MiniMax

旧知识库设置属于服务级配置，没有个人归属。迁移目标是组织共享目录，不需要指定某个接收用户名。迁移应在服务器内读取旧配置，新增独立条目并保留已有共享配置与默认模型；通过来源指纹和修订号实现可重复、无覆盖的导入。

导入工具为 `backend/scripts/import_shared_minimax.py`。输入必须是服务器本机的普通 0600 JSON 文件，包含 `scope: "service_shared"`、`provider: "minimax"`、`base_url`、`model` 和 `api_key`，不得包含个人 `owner`。该源文件不进入仓库、浏览器或本地交付物。

工具默认只执行 preflight；实际写入必须显式使用 `--apply --expected-revision <预检修订号>`。它只接受中国区 `https://api.minimaxi.com/v1` 或旧 `/anthropic` 来源；旧 Anthropic 配置须明确指定 `--destination-url https://api.minimaxi.com/v1`，不会自动换区或猜测协议。相同来源重复运行不增加条目，冲突返回 409，原来源和已有默认模型保留。

从仓库根目录运行预检的形式为：

```sh
PYTHONPATH=backend python backend/scripts/import_shared_minimax.py --source-file /服务器私有目录/legacy-minimax.json --destination-url https://api.minimaxi.com/v1
```

仅记录迁移状态和非秘密元数据；密钥保存在受保护的密文中，不写入浏览器、命令输出或普通日志。工具返回 `credential_verified: false`，不进行真实模型调用。密钥存在或导入完成不代表授权、额度、协议兼容性或连通性已验证。

## 单独部署与验收

此前线上只读调查发现，PM 两实例缺 `KNOWLEDGE_AI_ENABLED`、`KNOWLEDGE_AI_CLIENT_ID`，知识库缺 `DIKW_WEB_AI_GATEWAY_URL`。这是一份历史配置记录，部署前需要重新读取变量是否存在及非秘密匹配结果。

- PM：启用 `KNOWLEDGE_AI_ENABLED`，把 `KNOWLEDGE_AI_CLIENT_ID` 设为知识库自己的、已验证的 OIDC client ID；不能填写门户 client ID。
- 知识库：`DIKW_WEB_AI_GATEWAY_URL` 指向工作台 HTTPS origin。
- 将变量持久化到现有完整 Compose 配置链，保留其他环境、卷、IAM 和资料。与组织共享表迁移、旧 MiniMax 导入分别记录，不混入当前笔记版本的发布。
- 验证未登录拒绝、两个真实组织成员看到同一目录/默认/修订号、设置冲突保护、选择及切换模型、知识库问答/翻译/摘要/标签、退出与换账号后的身份校验。测试连接和真实模型请求只在明确触发时执行。

本地合成测试、配置存在检查、真实模型连通和生产部署是不同证据，不能互相替代。
