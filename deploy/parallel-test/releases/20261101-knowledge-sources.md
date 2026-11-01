# 知识源 · 2026-11-01

本次将已确认的「知识源」界面及真实知识库管理、ICH 手动下载功能发布到生产。入口为 `https://www.openlims.ai/knowledge-sources`。旧「行业信息」保持下线；已有论文、文件夹、采集记录及归档原件保留。

## 固定源码与镜像

| 服务 | 固定 main 提交 | 生产镜像 |
|---|---|---|
| 门户与两个 PM 实例 | `687bddcaa57eb0d3422c1aab61ce06ce674b0794` | `mb-pm:knowledge-sources-687bddc-20261101` |
| 知识库 BFF 与论文界面 | `9eb47fdb58cb0949fc6e6bb62a699adc90bcc553` | `dikw-mbweb:knowledge-sources-9eb47fd-20261101` |

实现与 pending archive 修复均经过对应 PR 的检查后合入 main，再从上述固定提交构建发布；没有将演示条目、预览计时器或私有配置写进生产包。PM 保留最新 main 中的助手实现及 `014` 迁移，不能回退成旧功能树。

代码交付：[PM 主功能 #106](https://github.com/OpenLimsAI/mb-pm/pull/106)、[PM 原件修复 #107](https://github.com/OpenLimsAI/mb-pm/pull/107)、[KB 桥接 #38](https://github.com/OpenDIKW/dikw-mbweb/pull/38) 均在各自最新提交全部 CI 成功后 squash 合并。合并树与已测试树逐项一致，官方固定源码包分别核验 626 / 237 个 Git blob 后构建。

- PM 镜像 ID：`sha256:c914922c18778d0dafb7a26c596fad3f38f1d74baef739d5ac3c59cb469ac73d`。
- KB 镜像 ID：`sha256:e1240c59086763a52a633e2cdefd986843163f0696bd41b712d1767d8b3aa439`。
- 实际实例启动时间（UTC）：KB `2026-11-01T16:10:51Z`，PM 域名实例 `16:13:47Z`，直连实例 `16:14:00Z`；只更新这三个服务。


## 本次功能与权限

- 工作台以「知识源」进入文件夹管理器，读取现有知识库全部授权论文与文件夹；支持新建、重命名、多选归类、从当前文件夹移动/移除及个人收藏。
- 文件夹修改只调整共享分类关系，不复制或移动原件。既有主关联兼容保留，多文件夹成员关系可由知识源与知识库共同使用。
- ICH 来源支持 Q/S/E/M 四类清单，明确选择后才下载。默认创建或复用 `ICH` 文件夹；其他来源可登记，完成适配前不能执行抓取。
- 下载原件与知识库索引分别显示。未索引、索引中或失败的收录，仅凭 BFF 当前 scope 的真实回执证明作为归档展示和读取；不提供尚不存在的 Core 阅读链接。
- 已在 Core 注册的论文被删除或不可访问时，不经 PM 归档重新出现。待索引阶段的分类保存在 PM，Core 实际注册后同步到同一份论文；收藏在归档与 Core 标识切换时保留。
- 所有写入继续校验现有门户会话、本站 Origin 与实时 IAM。Core 全库阅读需 KB 角色，分类整理需 `kb_manager`；公开 ICH 收录委托不扩大为通用上传、删除、模型设置或全库阅读权限。

## 后台与配置

生产显式启用 `KNOWLEDGE_SOURCE_APP_ENABLED=true` 和 `KNOWLEDGE_SOURCE_WORKER_ENABLED=true`；旧 `INFORMATION_APP_ENABLED=false` 保持关闭。新 `knowledge-source-collector` 仅处理带知识源 app 标记的手动任务，不执行旧队列，也不恢复历史来源定时监控。上线本身没有发起下载或索引。

沿用既有内部知识库连接、签名密钥、Core 凭据、共享原文卷及各应用配置。部署不复制密钥或令牌到浏览器，不新增公开桥接端口。

PM 运行需要 **完整六份 Compose 覆盖**：此前已验证的五份，加上本次 `releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`。六份文件依次为 `compose.yml`、`compose.production.yml`、`compose.direct.yml`、`releases/header-9516977/compose.no-note-sync.yml`、`releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`、`releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`，全部相对于 `/home/prometheus/mb-pm-v2`。后续运维应使用服务器上的统一 wrapper：

```sh
/home/prometheus/mb-pm-v2/releases/knowledge-sources-687bddc-20261101/compose-production.sh ps
```

该 wrapper 固定当前完整组合，不应自行省略私有或功能覆盖。镜像、配置组合和运行目标的记录位于同目录 `operations.json`；文档不包含私有配置值。

## 备份与验证

发布先备份数据库、运行配置、原文及知识库分类/回执数据，再使用隔离候选检查，最后切换固定镜像。PM 私有备份目录为服务器 `private-config-backups/knowledge-sources-687bddc-20261101`，KB 使用相应 `knowledge-sources-9eb47fd-20261101` 备份；备份留在服务器。

已提供给本记录的候选及切换后验证结果：

- 63 篇既有 Core 论文和 1 份 PM 归档仍可读取，原文哈希与原有标题一致，旧主文件夹关联保留。
- 既有记录 ID、模型设置和原配置保留；`014` 及成员相关表已核对，未通过恢复旧业务库实现上线。
- 旧行业信息保持关闭，知识源只处理手动任务；匿名权限边界和正常服务健康已检查。
- 没有在生产执行新论文下载、生产问答或付费模型验收，也没有新增测试论文。

最终核对：两个 PM 与 KB 均 healthy，17 个容器均运行，有健康检查者均 healthy；其余 14 个容器 ID/镜像未改变。38 张 PM 表的既有业务 ID 保留，模型设置文件摘要相同。旧采集任务 2 项内容摘要未变，新知识源任务 0 项；两个实例均出现 manual-only 新 worker 启动记录。旧 worker 不启动的结论来自 `INFORMATION_APP_ENABLED=false` 与真实启动门控及旧任务保持证据，不以 `docker exec` 子 Python 的线程列表冒充 ASGI 线程观测。

PM 原件 1 份、264104 字节及 Core 原文件 2974 份、43365273 字节的既有哈希保留；Core 63 篇逐 path / hash / 原标题一致。当前真实 pending proof 为 0；待索引、删除屏障及收藏过渡边界由两个 PR 的针对测试验证。合法但无收据的引用不获得 proof，非法引用格式实际返回 HTTP 400。

服务器回执：

- PM `/home/prometheus/mb-pm-v2/private-config-backups/knowledge-sources-687bddc-20261101/verification.json`、`library-live-verification.json`、`route-verification.json`、`cross-service-final-verification.json`。
- KB `/home/prometheus/dikw/private-config-backups/knowledge-sources-9eb47fd-20261101/verification.json`、`library-live-verification.json`、`resumed-candidate-qa.json`。
- 两个备份目录均含 `image.json`。候选首次因发布 QA 的虚构 documentId 不符合 hex64 契约而停止，未切生产；仅纠正 QA，并保留非法格式拒绝检查、首次备份与失败副本。补充 QA 脚本哈希已记录，产品源码树和镜像保持不变；完整候选重验通过后才发布。


## 验收范围

代码测试、隔离候选及服务端只读核对不代替客户本人登录后的使用验收。新建或重命名文件夹、选择 ICH 下载、暂停重试及下载后索引由用户在授权范围内主动执行；本次未启动这些生产写入验收。

源站和本机应急反代的 `/knowledge-sources`、`/login` 返回 200，静态 index 与固定构建 SHA-256 `5cace3ef741fa43994173121692c100eca59471253a3c147af4ce38c05244547` 相同；匿名知识源 API 返回 401。应急反代仅在回环使用已知自签名 TLS 校验，没有据此宣称公网证书已验收。

服务器到公网域名的页面探测为 403，API 探测超时；IAB 导航曾转到门户 `/login`，随后 DOM 工具超时。因此真实账号登录后的浏览器流程尚未验收，没有更改 Cloudflare 或公网安全配置。

## 回滚

回滚目标是发布前 PM `mb-pm:industry-off-2384eb8-20261101` 与 KB `dikw-mbweb:shared-notes-8d06503-20261101`。仅按本次备份恢复镜像与必要运行配置、重建本次更新的服务；恢复此前完整五份 PM Compose 组合，不继续带入新 worker 覆盖。

保留上线后的业务数据库、论文、原文、文件夹和新增成员关系；不还原发布前业务数据，不删除新字段、`014` 迁移或持久化分类表。代码回滚后新多文件夹信息应继续保留，以便重新发布读取。不得执行全栈 `down`、删除数据卷或覆盖用户新资料。

回滚 helper 为各自服务器发布目录的 `deploy.py`，先回退 PM、再回退 KB；需要固定源码 SHA 与各自 `image.json` 中发布包摘要参数。PM helper 复用原完整五份覆盖并只恢复镜像标签；KB helper 同样仅恢复旧镜像标签。`.env` 与 Compose 快照、在线数据库备份及原件 TAR 在上述私有备份目录；旧镜像 ID 已在发布前核验留存。本次未在生产执行回滚演练，失败自动保护和数据保留逻辑经过发布方案审阅及候选检查。

本记录及交接说明的补充属于纯文档 PR，不触发再次部署。
