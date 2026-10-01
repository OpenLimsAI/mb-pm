# 客户服务器部署记录

最新状态（2026-09-28）：**pm.openlims.ai 已上线「版本更新」模块，公网 HTML 与应用健康检查通过。** 本次仅更新前端，数据库、IAM、账号和 AI 配置保持不变。详见 [本次发布记录](releases/20260928-release-notes.md)。

以下为初次并行部署的历史记录；其中「待发布」步骤描述当时状态，当前公网入口已可访问，旧站最终数据迁移和其余账号开通仍须另行核验。

## 已部署

- 服务器：`prometheus@36.154.190.9:13568`
- 部署目录：`/home/prometheus/mb-pm-v2`
- 源码版本：本目录 `ca524d5`；镜像 `mb-pm:iam-20260928-ca524d5`
- 服务器源码快照：`/home/prometheus/mb-pm-v2/releases/iam-20260928-ca524d5`
- 应用：服务器 `127.0.0.1:18082`，健康检查通过
- IAM：服务器 `127.0.0.1:18001`，Casdoor `3.100.0`
- 独立 PostgreSQL 18 数据库与持久数据卷；`AUTO_SEED=false`
- 原项目管理 `mb-pm-app`、共享数据库和知识库保持运行

## 已验证

- 前端 TypeScript 检查与生产构建通过，包括服务器上的镜像构建。
- 后端 122 项测试通过；其中一个 HTTP 测试因沙箱端口限制单独补跑通过。
- 现网数据副本恢复：5 个项目、10 个子项目、165 个任务、190 个依赖、11 个用户、2 个模板。
- `020104`（admin）、`guo.cmc`（cmc_lead）真实授权码 + PKCE 登录、回调、角色识别、项目 API、退出及会话失效通过。
- Casdoor 默认控制台管理员密码已替换为独立随机值。
- 登录验收结果：服务器 `/home/prometheus/mb-pm-v2/verification.json`。
- 初始账号凭据仅保存在服务器 `/home/prometheus/mb-pm-v2/ACCOUNTS.private.txt`，权限 600。文档不记录密码。

一致性数据库备份位于服务器：

`/home/prometheus/mb-pm-v2/seed/mb_pm-20260928T022510Z.dump`

SHA256：`4d3d56c8376cf48be982b2a2e8d61d31742c755b6d959de6e98b6b5062d05751`

本次备份尚未下载到本地。它已经完整恢复到独立数据库；正式切换时还需刷新快照以包含此后业务写入。

## 待发布的域名

用户指定使用 `openlims.ai`；拟采用：

| 用途 | 域名 | 新 Tunnel 的服务目标 |
|---|---|---|
| 项目管理 | `pm.openlims.ai` | `http://app:8000` |
| 统一登录 | `iam.openlims.ai` | `http://casdoor:8000` |

Cloudflare 账户 `1ca5e2203de3b88e6e786c15149a94ee` 的域名已处于活动状态。用户已手动创建 Tunnel `Maibo-pm`，ID `9fd0232f-e065-4925-8c17-98e73f2ba463`。服务器连接器 `mb-pm-v2-tunnel-1` 已连接，Cloudflare 页面显示健康。连接令牌保存在服务器部署目录内 `tunnel-token`（600）；本机临时副本已删除。原 `maibo-pm.i-am-holo.top` 使用的是客户原有 Tunnel。

`compose.production.yml` **已应用于独立新版**。它启用 Secure Cookie、配置两个 HTTPS 域名、禁用包含 OAuth 参数的访问日志，并增加专用 Tunnel 连接器。Casdoor origin、应用回调、首页及资产 URL 已同步更新；旧配置备份位于服务器 `private-config-backups/`。已验证健康检查、登录地址和 OIDC issuer。上线前还必须：

1. 确认并发布上表两个 Cloudflare 公网路由，自动创建 DNS。项目路由表单已填好，尚未提交。
2. 验证两个公网 HTTPS 入口及完整 IAM 登录、退出流程。
3. 按用户确认开通其余 8 个启用账号；停用的 `zhao.pm2` 不开通。`provision_users.py` 已准备，尚未执行。
4. 正式切换前暂停旧应用写入，保留最后备份，将最终数据导入新的空数据库；不要覆盖已产生新版业务写入的数据库。
5. 用正式域名验收登录、退出、角色范围和数据；切换旧入口或重定向到新入口，保留旧镜像和旧数据库。

仅新入口就绪前，不应停止旧服务或将现有网站指向仅能通过 SSH 隧道访问的 IAM。

## 脚本

- `setup.py init <tag>`：一次性初始化独立测试栈；拒绝覆盖已有 `.env`。
- `setup.py secure-iam`：幂等核对随机管理员密码及应用配置。
- `copy_database.py`：只读导出现网库，恢复到**空的**候选库；非空目标拒绝操作。
- `verify_login.py`：读取 `.env` 中当前域名，通过真实 IAM 流程验收已记录的账号；不输出令牌和密码。
- `configure_domains.py`：备份独立新版配置，再更新为 `pm.openlims.ai` / `iam.openlims.ai`。
- `provision_users.py`：仅为启用用户创建新版 IAM 账号，继承已有业务角色；需按本次确认执行。

SSH 隧道可用于健康检查及内部诊断：

```sh
ssh -i id_rsa -p 13568 -N \
  -L 127.0.0.1:18082:127.0.0.1:18082 \
  -L 127.0.0.1:18001:127.0.0.1:18001 \
  prometheus@36.154.190.9
```

新版已改成正式 HTTPS 登录配置，因此本机 HTTP 地址不再用于完整登录。正式路由发布后使用 `https://pm.openlims.ai`。

Casdoor 不支持直接部署到 `/iam` 子路径，因此使用独立登录域名；依据 [Casdoor 维护者说明](https://github.com/casdoor/casdoor/discussions/4627)。
