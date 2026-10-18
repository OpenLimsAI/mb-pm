# 知识库负责人 / 用户权限交接

本目录为待发布配置，2026-10-18 未应用到生产。门户 / PM 与独立知识库仓库须分别完成 PR、CI 和合并，从固定 main 提交发布。不能只更新门户角色名称就宣称知识库权限已生效。

## 权限映射

| IAM 角色 | 应用身份 | 能力 |
|---|---|---|
| `admin` | 平台系统管理员 | 全部 PM 权限，包括 AI；不自动获得 KB 负责人 |
| `cmc_lead` / 旧 `project_lead` | 项目负责人 | AI 设置与项目分析；旧角色继续受项目范围限制 |
| 默认 `rd` / `production` / `qa_qc` | 项目成员 | 日常任务，无 PM AI 设置或使用权限 |
| `kb_manager` | 知识库负责人 | AI 设置、论文上传，以及用户能力 |
| `kb_editor` | 知识库用户 | 阅读、编辑、开始 / 重新翻译、知识问答 |
| `kb_viewer` | 历史只读 | 保留旧权限，明确改权后才升级 |

## 上线顺序

1. 备份 IAM、PM、KB 的数据卷与当前配置，记录原镜像、提交及代理配置，保留已有会话和译文数据库。
2. 在 Casdoor `mabpharm` 创建启用的空角色 `kb_manager`。不批量升级旧用户；由系统管理员在门户明确指定负责人。`kb_editor` 继续表示知识库用户。首次改权后退出并重新进入 KB。
3. 当前 KB 容器不能直连 Casdoor，只能访问 `iam-proxy` 的 OIDC 白名单。候选 [`iam-proxy.Caddyfile`](iam-proxy.Caddyfile) 仅增加 `GET /api/get-user`，完整查询串必须为 `owner=mabpharm&userId=<账号 ID>`，且使用 Basic 请求头；Casdoor 仍验证应用凭据。拒绝其他选择器、重复 owner 和额外参数，其他管理 API 和 UI 继续返回 404，凭据不进入 URL 或访问日志。
4. 发布前用 `caddy adapt` / `validate` 检查候选，按原挂载路径备份并替换代理配置，再 reload。先在 KB 容器内验证该查询能返回当前已验证 subject，检查非 Basic、其他组织和其他 API 均不被放行。此处的实际应用凭据读权限尚待部署时验证；不可为绕过失败扩大网络或管理 API 白名单。
5. 发布合并后的 KB 镜像，保留独立数据卷。KB 自动将 `kb_manager` 加入编辑角色映射，负责人校验先验证 BFF 会话，再实时查询 IAM 专用角色。IAM 不可用时，上传与 AI 设置拒绝执行，不用 `editor` 或平台管理员推断负责人。
6. 发布 PM / 门户镜像。门户仅写入 `kb_manager` / `kb_editor`，保留其他应用与中台角色。缺少启用的 IAM 角色时选项不可用。

## AI 配置在哪里

2026-10-18 只读检查：`dikw-mbweb` 与中台 `dikw-web` 的模型服务均由各自容器的 `DIKW_AGENT_PROVIDER`、`DIKW_AGENT_API`、`DIKW_AGENT_BASE_URL`、`DIKW_AGENT_MODEL`、`DIKW_AGENT_API_KEY` 配置，当前为 MiniMax、Anthropic Messages、`https://api.minimaxi.com/anthropic`、`MiniMax-M3`。不在中台浏览器“设置”里配置，也不读取 PM 的 AI 设置文件。

本次 KB 新增负责人可见的“AI设置”，保存到 KB 现有持久目录的 `ai-settings.json`（0600），优先于 KB 环境变量。留空保留密钥，变更接口地址必须提供新密钥；有正在运行的问答 / 上传 / 翻译时拒绝切换。它不改变中台 Agent，也不改变 Core 的索引、embedding 或综合分析模型。中台、KB Agent 与 Core 应分别管理配置。

## 验收与回滚

- 项目成员看不到 AI，直接调用全部 AI 接口被拒绝；管理员及项目负责人可用，旧项目负责人不能访问范围外项目或组合财务。
- KB 用户可读、编辑、翻译及问答，直接上传、查询或写入 AI 设置被拒绝；KB 负责人可上传和设置，密钥不回传浏览器。
- 修改 / 撤销 KB 负责人后，下次受保护请求立即核对 IAM；不能靠旧 `editor` 会话继续上传或设模型。
- 检查普通 / 深色主题、移动端、工作台返回链接、历史笔记及译文；模型真实调用单独验收。
- 回滚恢复原 PM / KB 镜像和代理配置，保留数据卷与新配置文件。旧 KB 不读取 `ai-settings.json`；不删除 IAM 角色成员或历史数据来回滚。若恢复旧 KB 镜像，旧版用户上传权限也随之恢复，须明确记录。

当前完成了代码与隔离测试、候选 Caddy 解析；生产代理规则、真实 IAM 负责人授权、真实模型及跨角色操作验收均待发布。
