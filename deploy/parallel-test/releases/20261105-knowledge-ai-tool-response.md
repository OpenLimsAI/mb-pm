# 知识库工具调用响应兼容 · 生产发布记录

状态：已部署。两 PM 实例健康，DeepSeek 与 Kimi 各一次真实合成工具调用验证通过；真实客户论文的完整问答仍待验收。

完成时间：`2026-11-06 01:33:16 UTC` / `2026-11-05 20:33:16 EST`（America/New_York）。实现 [PR #194](https://github.com/OpenLimsAI/mb-pm/pull/194) 在最新提交全部 7 项 CI 通过后 squash 合并；合并后 main 的 7 项 CI 也全部通过。本次记录是部署后的纯文档补录，不再次部署应用。

## 问题与原因边界

两条历史诊断均显示供应商已返回 HTTP 200、`finish_reason=tool_calls`，随后 PM 网关在 `knowledge_ai.response_data` 解析、校验响应时拒绝，返回 `model_invalid_response` / 503。

| 诊断 ID | 供应商 | 供应商耗时 | 网关失败耗时 |
| --- | --- | --- | --- |
| `824a48a36f1448408bccd48dc54d1ff6` | Kimi | 7,729 ms | 7,731 ms |
| `7aac10ed09024296962f447325d428d0` | DeepSeek | 1,874 ms | 1,876 ms |

可确定的故障位置是供应商响应返回后的网关校验，不是这两次请求等待 60 / 120 秒后超时。历史原始响应未保存或导出，不能确认当时具体被拒绝的字段。

独立复现参照 [DeepSeek 官方非流式工具调用示例](https://api-docs.deepseek.com/guides/thinking_mode/)，给合法工具调用附加 `index: 0`：部署基线以 `extra_forbidden` 拒绝，补丁通过。此案例证明了响应元数据的兼容缺陷，不能冒充两次历史响应。部署后的新验证虽均观察到 `index`，也不改变历史原始响应缺失的边界。

## 修复与固定版本

响应进入原有严格校验前，工具调用只保留 `id/type/function`，其中 `function` 只保留 `name/arguments`。不修改原始输入、不补造缺失字段、不跳过非法条目。客户端请求继续严格拒绝未知字段；工具声明/禁用、容量、结束原因、reasoning 续传与凭据检查保留。未修改超时机制或模型配置。

- 发布源码：`9fe91e95f40cfbe8e63835315e13c495a79bdbf7`；tree：`237f34fd69f03d60463ddd1214c74a45221ebe89`；PR 测试 head：`69904204462e8205ad23c28a0d70ab4efef69f5c`。
- 源码归档 SHA-256：`e5efd293da6a0912e36d3bdc26cfef4cb7130e83c629ff275142f1cd7502c8fd`。全部 1126 个文件的 blob、内容与模式逐项匹配 canonical Git tree。
- 实际运行镜像：`sha256:59d6c422dcb991adb19ae7dded69cad3d3747acff0015f34b0fdba229394ea22`，采用标准 Dockerfile 完整构建，包含后端解析修复。
- 固定旧镜像：`sha256:bb62ee6daadc9b7dd249c8af981c790180436b17ef20d7e70794eeaad2b84479`；旧源码 `258d9c6116d3081062324e47be1fbb5f0d4fdd3a`。
- 服务器发布目录：`/home/prometheus/mb-pm-v2/releases/kb-model-response-20261105-9fe91e95`。发布 manifest SHA-256：`f100bd6e3e9245bd32e41aedc2ea2a3076a291f713690dbc97dae62bbc83e3d2`，封存工具 20 项。

本地相关后端 252 项、独立 gateway 57 项通过。PR CI 后端 2213 项通过，目标覆盖率 93.14%；备份适配器 111 项通过。前端 150 文件 / 1244 项通过，路由、生产构建及匿名登录产物检查通过。

## 实际产物与数据保护

实际候选镜像的合成 HTTP、工具元数据/续传、严格输入拒绝、共享配置/笔记/知识源桥接和重启持久化验收通过。这些验收使用隔离合成数据，未调用外部模型。实际镜像 OCI/config/layer 绑定的 Trivy 扫描通过既有 HIGH/CRITICAL、ignore-unfixed 门槛；扫描报告 SHA-256 为 `4da4f4edeb323f77c2c7f7430003c7b741eaee5230daa12dc1ae1319c15f5788`。报告保留，临时扫描资源已清理。

静态原始字节对比并非完全相等。189 个文件逐项精确核对，仅在比较中归一化单个更新记录构建时间戳、空字符串与 `domain` 两个均进入相同 hostname fallback 的构建标记，以及资源名称和引用的 hash 级联后，其他全部字节一致；50 个文件改名、138 个文件原始字节相同。原字节门槛拒绝结果保留，随后对同一镜像完成延续校验，未重建镜像或修改产品产物。

首轮隔离验收另因公开合成夹具 `pm.py` 的 `0600` 文件权限问题终止；仅将其权限调整为 `0644`，内容 hash 不变，随后两阶段实际镜像验收通过。两项均属于发布验证环节，未据此修改产品代码或跳过失败记录。

新的在线加密备份位于本次目录的 `online-backup/maibo-online-20261106T012704Z-d2f70d.tar.gz.gpg`，SHA-256 为 `a14423ad0f63f92119c3dbee8704784cd076360c03c317f30c84dd48e09f2cca`。覆盖 3 个 PostgreSQL、21 个持久挂载和 11 个 SQLite，同一归档的隔离恢复验证通过。首次备份因采集期间会话文件集合变化而终止；原失败保留，保持一致性检查门槛后重新生成的新备份通过，不复用不完整结果。不宣称跨所有存储的全局原子快照。

本次保护的原件为 869 份、138,518,460 字节；原件清单 SHA-256 为 `99345a96ea36d204eff3abdd7182f91c1f7f5f6fa41d5bc2977a329bcc299d37`。发布结果确认原有数据保留，无数据库迁移或生产数据库恢复。

仅切换 `app` 与 `app-direct` 两个 PM 实例，均为上述新镜像和源码并保持 healthy；保留完整 35 份 Compose 输入，追加固定镜像覆盖至 36 份，原环境、限制、挂载和网络经发布护栏核对。知识库维持源码 `3f7f41a52f541ad5f1dbf6ad8513e43d8af37b31`、镜像 `sha256:d33aa80412e12ada82ce4ca6f4de9a2b7cc4e1030c2ccc680e7f453d0937a5a9` 和 16 份 Compose，未重启；共享 AI 设置指纹不变，知识源桥接兼容。

## 真实模型与公网验收

部署后使用现有共享配置，各向 DeepSeek、Kimi 发送一次合成工具请求，每次最多 1024 输出 token，不发送客户资料、不执行工具、不改模型配置。

| 供应商 | 次数 | 探针总耗时 | 新响应含 `index` | 网关规范化与工具轮 |
| --- | --- | --- | --- | --- |
| DeepSeek | 1 | 1.344 秒 | 是 | 通过，`finish_reason=tool_calls` |
| Kimi | 1 | 4.063 秒 | 是 | 通过，`finish_reason=tool_calls` |

两次真实响应均成功通过当前网关，配置未改变。它们只验证工具响应这一轮，不代表客户论文读取、工具执行、多轮最终答案或真实用户浏览器问答已经验收；历史两次错误的具体被拒字段仍未被还原。

公网 Python 只读检查的 6 次请求均返回 403，原失败回执保留，不能记录为 HTTP 全绿。随后通过实际浏览器观察 `www.openlims.ai` 与 `pm.openlims.ai` 各自 `/health`、`/build-info.json`，4 项响应正文均通过：健康为 `ok`、环境为 `production`，源码标识为本次固定版本，API 为 `/api/v1`、domain 模式。浏览器 DOM 未提供 HTTP 状态；未执行公网匿名鉴权浏览器验证，也未执行真实客户论文对话。

上述范围以本次 `release-summary.json`、`apply.json`、`provider-probe.json`、`public-browser-checks.json`、原 `public-checks.json`、备份/扫描/原件及各失败回执为依据；私密配置、账号 subject、密钥和客户正文不写入发布记录。

## 回滚

先确认两实例仍运行本次 `59d6c422…` 镜像，再按本次发布目录保存的完整原始 Compose 计划，将两个 PM 实例切回固定旧镜像 `sha256:bb62ee6daadc9b7dd249c8af981c790180436b17ef20d7e70794eeaad2b84479`，核对健康、权限、配置和知识库兼容。仅回滚应用镜像，保留现有业务数据和全部持久卷，不恢复旧数据库。后续若已有新版本上线，须重新核对，不能盲目执行此历史回滚目标。
