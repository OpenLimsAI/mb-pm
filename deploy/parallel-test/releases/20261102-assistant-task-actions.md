# 个人助手任务删除与恢复发布记录

- 发布日期：2026-11-02（America/New_York）。
- 状态：生产切换成功，服务检查通过；真实登录浏览器验收待补。
- 用户已明确授权本次“部署生产”，按已验证的固定版本执行切换。
- 上次切换因当轮未明确授权被自动审批拒绝，命令未执行，无需回滚。

## 发布版本

- PR：[任务列表删除与恢复修复 #117](https://github.com/OpenLimsAI/mb-pm/pull/117)。
- PR 全部 CI 成功后 squash 合入 main。
- 固定源码：`920f89a5b37bc6ecfeb33e90935c9d416bf53017`。
- 发布镜像：`mb-pm:assistant-task-actions-920f89a-20261101`。
- 镜像 ID：`sha256:ba4d994c10c32fbd15be2dd6b1c85509c5934ab26d0600b335ea8800482ba0ea`。
- 源码归档 SHA256：`60129617aad546c9fd9bb2ff1b9aad87cd045c1e5ed2ae3440a0706baac7012a`。
- 固定源码逐项核对 649 个 Git blob；镜像标签沿用构建日期，实际授权上线日期为 2026-11-02。
- 前端归档 SHA256：`b01e6a441b0d568dabc7578697d89d558b8b2b441df6a98af0735b679dc8f3c6`。

## 本次变化与范围

- 每条任务旁提供删除入口；详情加载失败时自动展开任务导航，删除前确认名称。
- 任务所有者可将无法阅读的旧任务移至回收站，或从回收站恢复。
- 删除和恢复仅变更状态、版本号与更新时间，返回任务摘要，不读取或返回受限历史。
- 保留 issuer、所有者、同源认证和 revision 并发保护；恢复后原历史阅读权限不变。
- 无数据库迁移；不代用户删除或恢复正式任务，不调用模型或搜索。
- 保留现有 DeepSeek 搜索、知识源、模型设置、挂载和网络配置，仅替换两个应用镜像。

## 发布前验证

- 本地干净 PostgreSQL 全量 1044 项、前端全量 713 项及构建通过。
- 生产数据库隔离副本验证：受限旧任务详情 403，所有者仍可软删除与恢复。
- 隔离验证确认响应仅含元数据，原消息完整保留，恢复后详情仍拒绝访问。
- 外人、跨 issuer 与过期 revision 均被拒绝；未修改正式用户任务。
- 候选镜像健康检查 200、匿名接口 401、助手入口 200、6 项路由检查通过。
- 候选镜像核对知识库连通、应用范围列、DeepSeek 就绪状态及个人模型选择隔离通过。
- 服务端依据：本次备份目录 `candidate-verification.json` 与 `image.json`；固定发布脚本 `releases/assistant-task-actions-920f89a-20261101/deploy.py`。

## 配置与备份

- 服务根目录：`/home/prometheus/mb-pm-v2`。
- 发布目录：`releases/assistant-task-actions-920f89a-20261101`（相对服务根目录）。
- 私有备份：`private-config-backups/assistant-task-actions-920f89a-20261101`（相对服务根目录）。
- 备份含原环境、七份 Compose、容器信息、模型设置、数据库快照与可验证 pg_dump；私密内容仅留服务器。
- 切换前另存 `database-switch-before.dump`、数据库与容器快照，切换后回执写入备份目录 `verification.json`。
- 继续使用以下七份 Compose，保留全部叠加配置：
  - `compose.yml`
  - `compose.production.yml`
  - `compose.direct.yml`
  - `releases/header-9516977/compose.no-note-sync.yml`
  - `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`
  - `releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`
  - `releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`

## 生产回执

- 实例启动 UTC：app `2026-11-02T05:39:37Z`，app-direct `2026-11-02T05:39:51Z`。切换前数据库归档 SHA256：`6cb1d96015049f578f6d601eb543dc96a09e2801c35d96ed737c9f577f40d33d`。回执为本次服务器备份目录 `verification.json`。
- `app`、`app-direct` 均运行上述固定镜像且 healthy；health 与助手入口 200，匿名接口 401。
- 已核对 38 张表原有记录 ID 保留、原助手消息哈希不变、企业模型配置哈希保留。
- 七份 Compose 仅应用镜像变化，其余 15 个容器的 ID 与镜像不变；无数据库迁移。
- 本机应急反代 `/assistant`、`/knowledge-sources` 返回 200，index SHA256 `13a21d6ee0aeb73fe238c231e602ec73d61a87e6d7954d41119ea5d197f54bcd` 与固定构建一致；匿名任务接口 401。仅回环使用既有自签名入口，不代表公网 TLS 验收。
- 公网自动访问为 Cloudflare 403，未改边缘配置；真实账号浏览器操作尚未验收。Core source 两次读数153/154为索引增长时的瞬时目录数，不是固定学术论文总量。
- 本次发布目录已补 `compose-production.sh` 与 `operations.json`，固定七份运行文件；生产回执已归档。

## 回滚

- 回滚镜像：`mb-pm:knowledge-compact-rows-20261101`。
- 回滚镜像 ID：`sha256:cb1dfde0ac036cf0ad1855f0c756f5924ed9540e56ca7d8ec2b7e9fc0f0f3795`。
- 在服务根目录执行已固定脚本；参数为 rollback、源码归档哈希、前端归档哈希：
  `python3 releases/assistant-task-actions-920f89a-20261101/deploy.py rollback 60129617aad546c9fd9bb2ff1b9aad87cd045c1e5ed2ae3440a0706baac7012a b01e6a441b0d568dabc7578697d89d558b8b2b441df6a98af0735b679dc8f3c6`
- 脚本恢复两个应用旧镜像并验证健康，不恢复业务数据库；切换异常时自动调用同一回滚流程。
- 本次切换成功，未触发回滚；生产运行新镜像，真实登录浏览器验收仍待完成。
