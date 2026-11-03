# 2026-11 安全升级与恢复

本目录的配置追加在**生产实例实际记录的全部 Compose 文件之后**。不以仓库示例覆盖现有 `.env`、私有知识库连接、网络或卷。数据库维护凭据只在单次迁移容器中使用；运行实例使用单独 DML 角色。脚本不输出密钥。

## 发布顺序

1. 等待 PR 最新提交全部 CI 通过并 squash 合并，记录 main SHA、生产当前镜像 ID、Compose 文件序列和配置摘要（排除值）。
2. 在服务器内执行加密备份；用备份恢复到没有公开端口的隔离数据库，确认数据计数、约束、登录元数据及应用健康。备份密钥和备份文件均为 0600、目录为 0700。
3. 固定源码构建新镜像。用隔离数据运行 `python -m app.db.upgrade` 和 `python -m app.db.runtime_role --output /private/runtime.env`。约束发现异常记录时直接中止，不自动修改客户数据。
4. 使用受限角色启动候选实例，验证 DML 可用、DDL/角色管理拒绝、后台任务、知识库连接与权限。候选不得启动采集/报告等生产后台工作器。
5. 停止同库写入与工作器后做最终快照，串行执行迁移。预先给原有持久卷配置 UID/GID 10001 写权限，保持 0600/0700；不放宽到所有用户可写。
6. 运行 `release.py`，先不加 `--apply` 验证当前镜像、完整 Compose 序列、所有 live 环境值、卷与网络和 UID 10001 挂载访问权限。通过后加 `--apply`；脚本将 `compose.security.yml` 的候选值固化为 0600 `.active.yml`，以后沿用实际容器标签里的完整文件序列，不依赖遗失的 shell 环境。只重建两个 PM 服务；失败会自动用记录的固定旧镜像与完整配置回滚。`direct-proxy` 回环端口和固定镜像也保留在最后覆盖文件中，但须先验证 SSH 转发与证书信任，再单独重建代理。
7. 健康、登录/刷新/改密、角色降级、知识库操作、助手后台任务检查通过后记录实际镜像。禁止把 CI 通过等同于真实身份验收通过。

发布前按实例核对门户配置：已启用独立门户的实例须保留完整 `PORTAL_PUBLIC_URL` / `PORTAL_CLIENT_ID` / `PORTAL_CLIENT_SECRET`；未启用独立门户的应急 PM 实例可保持三项均未配置，继续使用其原有 PM IAM 客户端。所有 `PORTAL_*` 配置均须逐值、逐项保持，检查会拒绝新增、丢失、变更或已有的半配置。

若检查失败，恢复原 Compose 序列与镜像，使用维护账号重新启动旧版；新增约束可保留，若旧版写入不兼容须评估后再回滚相应约束。不得直接用旧快照覆盖发布期间新写入的数据。

## 加密备份

在生产服务器使用现有 GnuPG 与 Docker：

```sh
python3 backup.py --directory "$HOME/backups/encrypted" \
  --key "$HOME/backups/private/backup.key" --quiesce \
  --include "$HOME/mb-pm-v2/.env"
```

脚本自动发现容器记录的 Compose 文件和所在目录的 `.env`，并在停写窗口把它们归档为 `config-files.tar`；其余未挂载的运维配置须用 `--include` 明确补充。不要传整个 home、备份目录或它的祖先目录。备份覆盖 PM/IAM/DIKW 三个 PostgreSQL 数据库，以及两 PM、知识库客户应用、Core、DIKW Web、IAM、Caddy 代理的全部持久 bind/volume 挂载，包括 Core `/base`、AI 设置、原文、SQLite/WAL 和内部 CA 证书。共享卷只保存一次，临时 tmpfs 不备份。MDM 属独立业务，未自动加入本脚本。

`--quiesce` 明确执行短时维护窗口：停止上述全部应用写入服务，保持 PostgreSQL 运行，依次做逻辑 dump、校验恢复目录并归档配置与持久卷；无论成功失败，都会重启原本运行的服务并检查健康。原本停止的服务保持停止；IAM 暂停会短时影响其他应用登录。数据库之间没有分布式事务，但这些应用停止期间不会继续产生跨系统写入；另有写入器时必须以 `--writer` 补充。备份清单记录每个归档文件的 SHA-256。文件复制或 dump 失败不保留可误认为成功的归档；加密包验证仍不能替代隔离环境真实恢复演练。

```sh
python3 backup.py --directory "$HOME/backups/encrypted" \
  --key "$HOME/backups/private/backup.key" --verify /path/to/backup.tar.gz.gpg
```

通过 `restore_check.py --backup /path/to/backup.tar.gz.gpg --key /private/backup.key --directory /new/private/recovery` 先完成认证、清单哈希和安全解包，再恢复至专用内部网络的新数据库，并验证 SQLite（含WAL）。具体命令、边界和真实恢复记录见 [RESTORE.md](RESTORE.md)。生产数据与密钥不得复制到开发电脑。

**异机目标尚未提供**：用户已确认暂无目标，本次只建立本机加密备份与恢复能力。不要声称已有异机容灾；获得认可的目标后，再配置加密上传、异地保留和恢复密钥的独立保管。每天备份调度和容量告警的实际状态以部署记录为准。

## 依赖与安全门禁

- 运行依赖通过 `backend/requirements.lock` 完整版本与哈希安装；基础镜像及 Actions 固定摘要/提交。
- Python 审计只接受两个精确版本的短期例外：ECDSA 签名侧信道（本应用不做ECDSA签名）与 python-jose HMAC/DER 混淆（验签明确只准 RS256，并有伪造拒绝回归）。有效期至2026-12-02，届时门禁自动阻断；任何新增漏洞均不在例外内。
- npm 高危及严重漏洞、源码疑似密钥、镜像中有修复版本的高危及严重漏洞阻断合并。镜像未修复漏洞仍须检查审计报告，不能以扫描通过推断没有风险。
- main 分支保护需要组织套餐支持；设置不能生效时仍执行 PR/全部CI/squash流程，但人工流程不等于仓库强制保护。

## 运行与维护入口

PM 运行容器使用非 root、只读根文件系统、无额外 capabilities、`no-new-privileges`、有界临时目录和内存/CPU/PID/日志。隔离候选必须覆盖 PDF 子进程、SQLite临时文件、信息归档与AI设置保存，避免权限加固导致功能失效。

公网应只经 Tunnel/HTTPS 访问。应急直连绑定回环地址，通过 SSH 本地端口转发访问；收紧前验证 SSH 与 Tunnel 可达，保留原代理配置用于回滚。不可为通过检查放宽 Cloudflare Access、TLS 或证书校验。

只清理未使用的构建缓存，保留当前与上一版镜像及所有数据库/文件卷；绝不执行 `docker system prune --volumes`。宿主机 SSH、防火墙及整机日志策略若缺管理员权限，必须记录待办，不能借容器权限绕过拒绝。


受限入口的维护示例：先 `ssh -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:18443:127.0.0.1:8443 ...` 建立仅本机监听的转发，再使用 `curl --connect-to 36.154.190.9:8443:127.0.0.1:18443 --cacert /path/to/verified-direct-root.crt https://36.154.190.9:8443/health`。CA 是公有证书而非私钥，须通过已验证 SSH 通道取得；此通道用于管理员诊断，普通浏览器登录仍走正常域名。

## 容量与服务检查

`monitor.py --output /private/report.json --backup-directory /private/backups` 检查固定生产清单中的服务（包括缺失、停止和暂停状态）、内存/CPU/PID/swap上限、日志轮转、磁盘余量与最新非空备份。报告只含状态与计数，不含环境变量或原始Docker错误；文件0600。额外候选容器不纳入检查或修改。默认只读，`--apply-limits` 才更新容器资源限制；长期配置仍须保存在各服务Compose并验证。没有外部通知目标时，服务器内报告不等于有人收到告警。

## 每日备份调度（计划，待部署）

计划在每日中国标准时间 **03:30（UTC+08:00）** 的短时维护窗口执行 `daily_backup.py --directory /home/prometheus/backups/daily --key /home/prometheus/backups/private/backup.key`，每 5 分钟执行一次 `monitor.py`。服务器 cron 时区必须明确设为 `Asia/Shanghai`（或换算成服务器时区），不可把 CST 当作美国中部时间。本次只交付工具，实际 cron 由运维执行者安装并记录；目前没有外部通知目标，监控 JSON/本机日志不代表告警已送达。

调度器只调用同目录 `backup.py`，强制 `--quiesce`，因此会短时停止应用写入并恢复健康。使用专用 0700 目录，和手工发布备份分开；密钥仍使用服务器私有 0600 文件。独立非阻塞锁防止调度重叠，与备份自身锁分开，避免死锁。新归档成功并再次通过 GPG 认证及归档完整性验证后，才清理专用目录中严格匹配 `maibo-YYYYMMDDTHHMMSSZ.tar.gz.gpg` 的非空普通文件：同时保留最新 **14 份**与至少 **14 天**，文件修改时间不足 14 天也保留。失败不清理；不递归、不跟随符号链接、不删除其他名称、子目录或手工备份目录。日志仅记录状态、归档 basename 和删除数量，不输出密钥或子进程错误原文。监控的 `--backup-directory` 应指向这个实际调度目录；容量不足会停止新备份并保留旧备份，须人工处理，不能先删旧副本换空间。
