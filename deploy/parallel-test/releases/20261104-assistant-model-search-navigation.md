# 个人助手模型联网联动与成果导航（2026-11-04）

已上线固定 main `2ec58ecafb9da836699f69896ec30adabad255ec`。代码 [PR #166](https://github.com/OpenLimsAI/mb-pm/pull/166) 的最新提交全部 7 项 CI 通过后 squash 合并。公网核验时间：2026-11-04T18:00:53.711740+00:00。

## 用户可见变化

- 选择官方 DeepSeek 或 Kimi 模型时，联网搜索随该模型账户切换；Kimi 保留中国区或国际区端点。官方地址、密钥归属与重定向边界受校验，不跨厂商转发模型密钥。管理员明确配置 Tavily 时仍使用独立搜索服务；未接入的模型显示可操作的真实提示。
- 数据设置只管理项目管理、知识库应用数据，移除联网提示；当前搜索服务在回答方式旁显示，模型切换或设置更新后重新检查，不残留旧模型错误。
- 多份产物改为可见卡片列表，提供轮次、日期、模型、最终成果与选中标识，支持查找和键盘选择；切换产物回到正文顶部。外部打开被过滤隐藏的产物时自动解除过滤。
- 提问正文可以选择并复制，并提供“复制提问”；修复跨模式追问丢失主题、连续重答丢上下文、迟到模型设置覆盖任务选择和错误重复展示。

## 验证与验收范围

本地全量前端 111 文件 / 988 项通过，后端 1681 项通过、4 项 PostgreSQL 专属用例跳过（CI 中使用 PostgreSQL）。代码最新 head 的 7 项 CI 全部成功。

候选实际镜像通过 38 项隔离策略断言，无网络、无注入凭据、无真实模型调用，覆盖原生搜索官方端点及跨厂商边界、既有输出预算和恢复策略。177 份实际静态文件的哈希与清单一致；原生 CUA 检查实际镜像登录表单用户名和密码可编辑、提交按钮启用，模拟匿名接口返回 401，没有输入真实凭据或提交表单。

双实例健康，公网健康、助手页面、静态清单和助手模块均为 200；匿名任务 API 为 401；公网产物与实际镜像逐项匹配。本机公网核验经显式 HTTPS 代理完成，未降低 TLS 或哈希检查。

尚未以客户账号进行真实付费搜索、模型回答和业务正确性验收；上述测试与匿名检查不代表这些业务路径已实测。本次发布检查未调用收费模型。

## 运行时、数据与配置

从旧生产 `70e55930372cabae9277b8ddd5a8d36e8f646d6d` 到本次候选共 11 个后端运行路径变化；旧镜像 168 个、新镜像 173 个运行文件分别与固定源码逐文件匹配，摘要 `b630e1eeb08f4f577f5d76f3523a98c794defeafef524bee60eb591dc94be624`。

- `app/api/v1/knowledge_ai.py`
- `app/core/config.py`
- `app/main.py`
- `app/middleware/notes_embed.py`
- `app/middleware/request_limits.py`
- `app/schemas/knowledge_ai.py`
- `app/services/answer_modes.py`
- `app/services/assistant.py`
- `app/services/assistant_history.py`
- `app/services/knowledge_ai.py`
- `app/services/web_search.py`

本次固定 main 同时含原已合入的知识库统一 AI 网关代码；旧生产 `KNOWLEDGE_AI_ENABLED` 未设置、按默认关闭，且没有客户端 ID。候选和两个实际实例再次确认该功能关闭且客户端未配置，本次没有启用网关、增加环境变量或修改客户端配置。

没有数据库迁移或历史数据库恢复。发布核验 53 张表，保留原记录 ID、助手历史消息、模型设置和安全设置；其他 22 个容器不变。完整 25 份 Compose 输入保留，仅追加镜像覆盖，发布后 26 份。四把锁、私有备份、在途任务检查及精确镜像回滚保护保留。

## 镜像与回滚

- 当前镜像：`mb-pm:assistant-experience-2ec58ec-20261104`，ID `sha256:8509ec97db0ac1e03cb41f0120549ec233fc839764e25ec38b1fc1591119af60`。
- 源码归档 SHA-256：`f22cc0fab548e1290931740dfabecad7983c87ecd3f2c77caa5fcb03e9335f2d`；实际静态包 SHA-256：`3c3b484e064425b881498633111b22732483d5d3d508e08d38bffd3ec7d70336`。
- 发布目录：`/home/prometheus/mb-pm-v2/releases/assistant-experience-2ec58ec-20261104`；私有备份目录：`/home/prometheus/mb-pm-v2/private-config-backups/assistant-experience-2ec58ec-20261104`。
- 回滚固定旧镜像：`sha256:2c57b957ba5b99ff47216606222915725cdf565215560938873c2183ca295961` / `sha256:2c57b957ba5b99ff47216606222915725cdf565215560938873c2183ca295961`，以及回执中的完整基线 Compose 输入。操作前排除后续发布，只回退应用镜像，保留当前业务数据库和卷；本次没有实际执行回滚。

结构化证据见 [JSON](20261104-assistant-model-search-navigation.json)。私有配置、密钥、用户问题和业务数据不入仓库。文档单独走 PR、全部 7 项 CI、squash；文档合并后不重复部署。
