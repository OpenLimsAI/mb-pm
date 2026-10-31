# AI 助手 DIKW 只读工具 · 生产发布记录

核对日期：2026-10-31（America/New_York）。[PR #76](https://github.com/OpenLimsAI/mb-pm/pull/76) 已 squash 合并；源码固定 `e294fdc9d0ac53ec0992325dc6135c3e00ac5b55`，PR 与合并后 main 的全部 CI 通过（main [运行记录](https://github.com/OpenLimsAI/mb-pm/actions/runs/41169281830)）。本地完整后端 754 项测试通过。

## 版本与范围

- 镜像：`mb-pm:assistant-dikw-e294fdc-20261031`，实际 ID `sha256:4b8e30229f41f684c372153a479c5f7ac7dfba062cd137b1de731ad33b3c2a8c`，OCI revision 与上述提交一致；源码归档 SHA-256 `51080d1cd13f938f47b0cbb8398635f76a554a808a9dea83df25425b5226f42f`。
- 从该提交独立归档在服务器构建完整镜像，仅省略 Dockerfile 的 syntax frontend 下载指令；依赖、应用构建和运行命令保留。没有新增数据库迁移、依赖或公开端口。
- 助手选中知识库后可按需使用 `dikw_health`、`retrieve_knowledge`、`list_pages`、`read_page`、`page_links`、`list_wisdom`；保留实时 KB 角色、固定服务端连接和只读边界。Core 0.6.10 的智慧查询使用统一页面接口。
- 生产此前缺少三项 `SOLUTION_KB_*` 配置。本次在服务器内复用现有 Core 服务令牌，写入权限 0600 的 `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`，供 `app` / `app-direct` 使用。凭据未输出、未复制到 Mac 或 Git。两个实例使用内部 `http://dikw-caddy:80` 和公开知识库入口 `https://kb.openlims.ai`。

## 网络、切换与验收

第一次切换中，主实例读取成功，但直连实例无法解析代理名称，触发脚本自动恢复两实例原镜像及原 Compose 组合；未恢复或覆盖数据库。两实例恢复 healthy。

直连实例接入了已有 `maibo-information-bridge`，但知识库代理未接入。将现有 `dikw-caddy` 无重启连接到该 internal=true 网络，并在 `/home/prometheus/dikw/docker-compose.yml` 的 caddy 网络列表中持久化增加已声明的 `information-bridge`。配置解析对照确认只有这一项网络成员变化。原文件留在 `/home/prometheus/dikw/assistant-bridge-backups/e294fdc-20261031/docker-compose.before.yml`。代理路由、公开端口、证书校验、Cloudflare 与认证策略均未修改。

候选镜像分别从 edge 和内部信息桥完成实际 Core 只读检查：健康、有效目录、原文、入出链、智慧列表及检索均通过；当时共有 1,718 个有效页面、63 篇有效论文，中性主题检索返回 3 个片段。检索可能使用 Core 原有嵌入配置；未调用生成模型，未改写论文或业务记录。

第二次切换成功，两个应用容器均 healthy，并从各自实际容器再次读取到 63 篇论文。仅重建 `mb-pm-v2-app-1` 和 `mb-pm-v2-app-direct-1`，其他容器 ID 未变。两个实例保留 `NOTES_WISDOM_WORKER_ENABLED=false`。启动日志未观察到 traceback、fatal、uncaught 或 unhandled 模式。

公网助手页面返回 200，PM `/health` 返回 200，匿名助手 API 返回 401，TLS 校验通过；内部匿名助手 API 也为 401。实际客户登录后的模型自主选择工具、跨轮问答、引用质量和不同角色的真实业务验收仍待完成；不由上述 Core 连通性检查推定通过。

## 备份与后续发布

私有备份留在服务器 `/home/prometheus/mb-pm-v2/private-config-backups/assistant-dikw-e294fdc-20261031/`，包含原部署配置、AI 设置和数据库归档。首次备份 `database.dump` SHA-256 `2ccd1af9e7caf0538571b3cbe9fdfc17174ca0f8b5916446e143b58502e3518b`；第二次切换前刷新为 `database.before-second-switch.dump`，SHA-256 `6d86521cf36c30fdb4964774102232b7e97e025d386fd4899bf32561fc4a4cfd`。两份归档均已用 pg_restore 验证可读，未下载到本机。源码和发布脚本位于服务器 `releases/assistant-dikw-e294fdc/`。

后续 PM 发布须继续使用现有 `compose.yml`、`compose.production.yml`、`compose.direct.yml`、`releases/header-9516977/compose.no-note-sync.yml`，并加入上述私有知识库连接覆盖文件。不要输出带凭据的 Compose 展开配置。后续 KB 代理发布须保留其信息桥网络成员关系。

## 回滚

保留的代码回滚镜像为 `mb-pm:header-9516977-20261030`，ID `sha256:0367444b58fcb70c7fa78b2a4f78d9e9761606f944f66255bf1f7cf367e5e3c9`。确认当前版本后仅将 `.env` 的 `PMS_IMAGE_TAG` 改回旧 tag，使用以上五个 Compose 文件仅重建 app / app-direct 并复查健康；这保留新连接，旧版采用原有论文预读流程。

首次自动回滚已实测原四文件组合可恢复健康；如同时撤回本次连接，应明确停用私有覆盖文件并协调代理信息桥网络的依赖，再精确撤销本次网络增量。不要整份覆盖后续配置、删除数据卷或用旧数据库备份覆盖新业务记录。
