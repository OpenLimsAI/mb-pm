# 隔离恢复演练

`restore_check.py` 只在客户服务器执行。备份、密钥、解密文件、恢复数据和数据库
连接文件都留在服务器；不能复制到开发电脑。它不停止、查询或写入原生产数据库，
也不复用其他任务的候选容器、网络或卷。

## 执行方式

先确认 `--directory` 是服务器 home 下尚不存在的目录，父目录已经存在，且至少
还有 5 GiB 空闲空间。归档累计解包上限为 8 GiB、200,000 项；不得为绕过失败
而关闭路径或校验和检查。

```sh
python3 restore_check.py \
  --backup "$HOME/backups/encrypted/maibo-YYYYMMDDTHHMMSSZ.tar.gz.gpg" \
  --key "$HOME/backups/private/backup.key" \
  --directory "$HOME/restore-drill-YYYYMMDD"
```

脚本依次完成：

1. GnuPG 认证解密完成后才解包，验证 manifest 覆盖的每个 SHA-256；拒绝未列入
   manifest 的内容和未支持的恢复项目。
2. 拒绝绝对路径、上级目录、重复文件、符号链接、硬链接和设备节点。文件写入独立
   0700 目录，权限限制为 0600/0700；绝不按归档原路径覆盖宿主机文件。
3. 恢复所有文件挂载与配置到 `restored-files/`，在副本上检查 SQLite 完整性并读取
   WAL 中已提交的内容。`mounts.private.json` 保存原挂载目标和独立恢复路径，供服务器
   内恢复检查；该文件不得公开或下载。
4. 创建带 `org.maibo.restore-check` 标签的新 Docker internal 网络、三个专用卷及
   容器。使用备份记录中的固定数据库 image ID，禁止拉取镜像，不发布端口，不连接
   生产网络。每个数据库限制 768 MiB 内存、1 CPU、128 PIDs，并使用有界本地日志。
5. 仅生成随机恢复账号，写入服务器私有 env；等待最终 TCP 服务就绪后执行
   `pg_restore --no-owner --no-acl --exit-on-error`，汇总普通业务表数与行数。

`report.json` 和标准输出只包含完整性结果、数量、新资源名称及恢复目录；原始配置、
SQL 错误或凭据只留在受限的服务器文件。失败时返回非零，保留本次独立资源供调查，
不会自动删除备份、原业务数据或其他任务资源。

数据库容器、卷、网络和解密文件会保留，以供恢复检查与后续受控清理。每个数据库的随机连接信息
在 `<database>.connection.env`（0600），不要在命令行、聊天、CI 或日志中输出其内容。
本轮没有用恢复的客户数据启动候选应用；应用验收使用全新合成数据库、真实 Core/IAM
和独立账号，并禁用外部模型及生产后台工作器。恢复的 IAM 只反映备份时配置，不证明当前登录策略。

## 2026-11-02 实际演练记录

输入备份为 `maibo-20261102T171034Z.tar.gz.gpg`，密文大小 222,631,097 字节。
本次只在服务器运行，未读取原生产数据库来比较数量，也未把客户数据复制到 Mac。

| 项目 | 结果 |
| --- | --- |
| GnuPG 认证 / manifest SHA-256 | 通过 / 24 个 payload 全部一致 |
| 文件归档 | 19 个挂载，4,248 项，累计校验解包 560,119,990 字节 |
| SQLite | 9 个数据库完整性全部通过；26 表、1,102 行 |
| PM `mb_pm` | 40 表、1,141 行；dump 含 40 个 TABLE DATA 项 |
| IAM `casdoor` | 44 表、1,700 行；dump 含 44 个 TABLE DATA 项 |
| `dikw` PostgreSQL | 0 表、0 行；原 dump 为 1,729 字节，0 个 TABLE DATA 项 |
| 隔离检查 | internal 网络；3 个容器运行；0 个公开端口；连接 env 全部 0600 |
| 演练后可用空间 | 17,659,592,704 字节 |

`dikw` 的空结果与该备份 dump 的目录一致，不是恢复过程忽略表；Core 文件和 SQLite
另在文件归档中验证。它不证明原线上数据库在此后仍为空，也不替代候选应用业务验收。

服务器证据目录：`/home/prometheus/restore-drill-20261102-review/`，其中
`report.json` 与 `isolation-verification.json` 保存数量和隔离结果。
`final-tool-verification.json` 记录实际执行版本与最终工具的 SHA-256；最终增加的
归档完整覆盖、SQLite 无效头等检查已在同一恢复副本上复核。挂载清单的
`restored_path` 指向解包后的实际文件或目录，可供候选准确挂载；`archive_directory`
是外层归档包装目录，不应直接代替原挂载根。

专用网络为 `maibo-restore-20261102173150-19c05e`。恢复容器为：

- `maibo-restore-20261102173150-19c05e-mb-pm`
- `maibo-restore-20261102173150-19c05e-casdoor`
- `maibo-restore-20261102173150-19c05e-dikw`

对应数据卷为容器名加 `-data`。三个数据库均使用备份固定镜像
`sha256:42e7f6b4e1eceb02ff14e3e6bc6108bbe259abbe83879dc1845d0da1ddeb555d`。
后续清理必须依据这些精确名称和标签，只处理本次恢复资源。

R06 的本机恢复证据已补充；异机目标尚未提供，因此**没有建立或宣称异机灾备**。
本次恢复只覆盖备份 manifest 所列 PM/IAM/KB/Core 数据，不扩大为独立 MDM 恢复验收。
后续每日备份已调度，并自动包含新持久化的 IAM `/tmp`、`/logs`；这不扩大上述旧备份的实际恢复范围。
灾难恢复优先使用空登录会话卷要求重新认证，不默认恢复备份中可能已注销的会话。

离线测试从 `backend/` 运行：

```sh
python -m pytest tests/test_security_restore.py -q
```

本次恢复工具 13 项离线安全测试通过；连同部署与监控测试合计 44 项通过。
