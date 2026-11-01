# AI 助手知识库连接恢复核对（2026-10-31）

日期按 America/New_York 记录。本次请求为恢复生产 `SOLUTION_KB_*`，不更新应用源码、不部署知识库统一笔记。

## 恢复与版本

核对期间，另一个发布操作于 16:49 UTC 前后使用完整五文件 Compose 组合重建了两个 PM 实例。独立复核确认运行环境已恢复，不再重复重建。

- 两实例镜像保留 `mb-pm:assistant-enter-508b438-20261031`，image ID 为 `sha256:b7999ad3a4bcc00fdcbc3562ee3ae6631de7c0576f4db4682a5ece5b1b523dda`。该镜像保留 e294fdc 后端并更新 508b438 前端，OCI revision 不代表前端版本。
- 两实例的三个连接变量均与权限 0600 的既有 `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml` 一致。内部 Core 入口为 `http://dikw-caddy:80`，公开入口为 `https://kb.openlims.ai`；令牌仅在服务器内比较，不输出、下载或提交。
- 代理原有 edge / maibo-information-bridge 网络均已存在，本次核对未更改网络、路由、IAM 或 TLS。
- `NOTES_WISDOM_WORKER_ENABLED=false` 保留，知识库统一服务端笔记未随本次恢复部署。

## 独立只读验证

候选容器分别在 edge 和 maibo-information-bridge 验证成功；随后从 `mb-pm-v2-app-1` 和 `mb-pm-v2-app-direct-1` 两个实际运行容器再次验证：

- 应用 `solution_knowledge.configured()` 为真。
- Core 健康、活动目录、原文读取、入出关联和 Wisdom 列表全部通过。
- 两实例均读取到 1,718 个活动页面、63 篇有效论文；不输出标题、正文或私有信息。
- 校验仅使用 GET，没有检索 POST、生成模型调用、论文/笔记写入或历史数据迁移。
- 助手页面 HTTPS 200；PM 健康接口 HTTPS 200；匿名助手接口 HTTPS 401；TLS 校验均通过。
- 真正登录后的模型自主工具调用及回答质量仍待实际账号验收；连通性通过不能替代模型问答验收。

## 后续发布与检查

后续 PM 发布继续使用 `compose.yml`、`compose.production.yml`、`compose.direct.yml`、`releases/header-9516977/compose.no-note-sync.yml` 和 `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`。

三个 `SOLUTION_KB_*` 由 `services/solution_knowledge.py` 直接读取 `os.environ`，不是 Settings 类字段。使用 `getattr(settings, name, None)` 会给出错误的缺失结论；应检查进程环境的存在性及 `solution_knowledge.configured()`，并执行只读实际请求。不得输出变量值或带凭据的 Compose 展开配置。

恢复前的缺失记录是当时快照，见[本地核对](../../../docs/verification/2026-10-31-local-reconciliation.md)；本记录更新当前连接状态。原 [DIKW 发布记录](20261031-assistant-dikw-tools.md) 的备份和配置保存位置保持不变。本次未恢复或覆盖数据库。
