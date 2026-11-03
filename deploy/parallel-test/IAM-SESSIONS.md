# IAM 会话、诊断日志持久化与迁移

Casdoor 的文件会话不保存在 PostgreSQL。当前 `redisEndpoint` 为空，进程工作目录 `/`，官方 [v3.152.0 初始化代码](https://github.com/casdoor/casdoor/blob/v3.152.0/main.go#L35) 把会话放在 `./tmp`，即容器 `/tmp`。没有卷时，替换 IAM 容器会丢失浏览器 SSO；门户自己的会话仍有效，其他应用却需要重新登录。

基础 `compose.yml` 与独立 `compose.iam-session.yml` 都使用两个固定卷：`mb-pm-v2-casdoor-sessions:/tmp` 与 `mb-pm-v2-casdoor-logs:/logs`。会话与诊断日志分开保存，避免以后恢复旧日志时恢复已注销的会话。生产不得直接用新的基础模板覆盖现有文件；必须迁移当前会话并追加 overlay。迁移不改账号、密码、角色、会话期限、数据库或镜像版本。已经丢失的旧会话无法由此次迁移恢复。

## 首次生产迁移

先完成 PR、全部 CI、squash 合并；记录固定 main。等待其他发布结束，读取**当前** IAM 镜像 ID 与容器标签里的完整 Compose 文件顺序。脚本自动使用该顺序，不把仓库示例当成现网配置。

```sh
python3 migrate_iam_sessions.py \
  --expected-current sha256:填写当时的完整镜像ID \
  --directory /home/prometheus/mb-pm-v2/releases/iam-sessions-新标签
# 只读检查通过后，使用相同参数增加 --apply。
```

默认只读检查包括：当前固定镜像、完整 Compose 输入、运行环境、Compose config-hash、OIDC discovery、目标卷不存在，且配置差异只允许新增会话与日志卷。任何已有 `/tmp` 或 `/logs` 挂载、现存目标卷、配置漂移均停止，不能绕过检查或删除卷强行继续。

`--apply` 在实际部署目录同时获取 `.iam-security-release.lock`、`.security-release.lock`、`.release.lock` 非阻塞锁。锁只是合作约定；执行前仍须确认没有未遵守锁的其他发布。锁内再次比较容器 ID 和所有 Compose／`.env`／已挂载配置文件摘要。然后：

1. 短暂停止**仅 IAM**，把 `/tmp`、`/logs` 原样保存为各自 0600 的 `sessions.private.tar`、`logs.private.tar`，发布目录为 0700。
2. 拒绝路径越界、链接或设备等异常条目；只向新建空卷解包，保留 UID、GID、模式和内容。
3. 分别再次导出卷为 `seeded-sessions.private.tar`、`seeded-logs.private.tar`，逐文件比较 SHA-256、UID、GID、权限和目录结构；不把文件名、cookie 或内容输出到日志。
4. 用原完整 Compose 链追加 `iam.sessions.active.json`，只重建同一固定镜像的 `casdoor`；现有安全配置和其他服务保持。
5. 等待 IAM 的原 OIDC discovery 完整恢复，保存只含每个存储的数量、摘要、镜像、卷与验证布尔值的 `verified.json`。

会话复制／验证失败会启动尚未替换的原容器。替换后启动失败只重试同镜像＋同已迁移卷；仍失败立即报错，使用私密 `recovery.private.json` 中的完整命令恢复，不回到空容器层。不要删除会话卷、执行 `down -v` 或用旧数据库覆盖现网。私密 tar 含可用于登录的会话材料，必须留在服务器受限目录，纳入现有加密备份后按受限保留策略清理；不得上传 Git、工单或开发电脑。

## 防止再次退化

- 后续发布从正在运行的容器标签读取全部 Compose 文件，并保留 `iam.sessions.active.json`；即使最终迁回仓库基础模板，卷名仍相同。
- 首次迁移验收后，备份服务器实际基础 Compose；仅在 `casdoor.volumes` 新增 `casdoor-sessions:/tmp` 与 `casdoor-logs:/logs`，在顶层 `volumes` 新增对应固定 `name` 为 `mb-pm-v2-casdoor-sessions`、`mb-pm-v2-casdoor-logs`。用实际完整链重新解析，比较其全部服务、网络及卷必须与追加 overlay 后完全一致，再保存。不要用仓库基础模板覆盖现网文件。这个精确补充确保旧的普通 Compose 启动命令也继续挂同一个卷；脚本不自动编辑现网 YAML，需要执行者完成并记录该核对。
- `deploy/security/monitor.py` 对 IAM 增加 `casdoor_sessions_persistent` 与 `casdoor_logs_persistent`。没有可写的持久 `/tmp` 或 `/logs` 卷（包括误换为 tmpfs）会告警，不会因数据库或 `/health` 正常而通过。
- `deploy/security/backup.py` 自动备份 IAM 的所有持久挂载，新会话卷随日常加密备份纳入。常规迁移用即时快照保留会话；灾难恢复时，**不应默认恢复陈旧登录会话**，旧备份可能包含后来已退出／撤销的会话。恢复账号与业务数据后，优先使用空会话卷让用户重新认证；恢复旧会话须另行核对注销与权限撤销边界。

## 验证范围

本地回归位于 `backend/tests/test_iam_session_migration.py` 和 `test_security_monitor.py`，覆盖配置／密钥漂移阻断、不可覆盖旧卷、路径安全、内容和权限比较、复制失败恢复、监控失败信号。它们进入现有 backend pytest CI，不需要访问生产。

发布前必须用独立 IAM 和独立数据库上的合成账号验证：无卷时同 cookie 在容器重建后失去身份；持久卷时同 cookie 在重建后仍对应原账号。不要重建生产 IAM 只是为了证明旧故障。生产验收另外确认工作台进入知识库和报告资料加载；匿名 discovery、文件摘要或合成账号测试均不能替代真实用户授权链验收。

2026-11-02（纽约时间）的隔离真实 IAM 实验已通过，见[去敏验证回执](../../docs/verification/2026-11-02-iam-session-rebuild.json)。可重复执行 `python3 verify_iam_session_rebuild.py`：该脚本在服务器新建独立内部网络、空数据库与合成账号，读取当前生产镜像 ID 但不复用生产配置或数据；验证无卷丢失身份、迁移保留身份、有卷重建保留身份后自动清理自己的资源。需服务器 Docker 权限和短时测试资源，不作为日常无副作用巡检执行。

## 日志轮转与保留

现场 `logConfig` 使用 file sink，`logs/casdoor.log` 在未持久化容器层，`maxdays=99999`。数据库 `record` 表保留业务审计记录，不能代替这些程序诊断日志；应与会话在同一次停止窗口迁移，保留已有文件与权限。

Casdoor [v3.152.0 go.mod](https://github.com/casdoor/casdoor/blob/v3.152.0/go.mod#L23) 固定 Beego v2.3.8；其 [file.go](https://github.com/beego/beego/blob/v2.3.8/core/logs/file.go#L34) 确认 `maxdays`、`maxsize`（字节）、`daily`、`rotate` 字段。目标为14天、10MiB大小触发轮转（单条日志可能越过边界，非文件硬配额），同时每日轮转。仅更新这四项，保留原sink、文件名、权限及其他设置。

在服务器准备受限配置副本：

```sh
python3 configure_iam_log_retention.py \
  --source /home/prometheus/mb-pm-v2/app.conf \
  --expected-sha256 当前app.conf的完整SHA256 \
  --output /受限发布目录/app.conf.prepared
```

脚本不改线上文件；核对副本差异只有 `logConfig` 的四项后，先备份原配置，在发布锁保护下替换绑定源的内容并保留原文件权限，再执行存储迁移脚本预检查／应用，确保IAM仅重建一次。新增基础模板已设置这四项。不要先单独重建IAM来更新轮转，以免再次丢失当前未迁移会话。日志tar和日志卷可能包含敏感请求信息，继续采用服务器受限权限和加密备份；普通文档只保存计数与摘要。
