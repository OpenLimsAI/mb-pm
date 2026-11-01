# 登录连续性与研究现场保护生产发布

- 日期：2026-11-01（America/New_York）
- 功能 PR：[OpenLimsAI/mb-pm#100](https://github.com/OpenLimsAI/mb-pm/pull/100)
- 固定 main：`e93056dd1beaae5c982bd516a41a0c59469caf65`
- 镜像：`mb-pm:session-continuity-e93056d-20261101`
- 镜像 ID：`sha256:bda45719af6eb65de6822e3d285139a5f75535f56fd0d04305450c7dcae77432`
- 源码归档 SHA-256：`a67a8aa737d67113ccf3b564c2a52ca54190d4f4ea48dfafd6aaca0a0cf0a633`
- 回滚镜像：`mb-pm:report-sources-off-12d89e8-20261101`

## 结果与边界

四项修复已上线：服务端短令牌续期、单点登录三态恢复、研究报告工作现场恢复、脱敏鉴权诊断与回归测试。默认空闲 1 小时、完整登录最多 8 小时、提前 120 秒刷新。统一退出、账号停用、角色与客户端边界保留，原始授权链的撤销在刷新前后及后续请求均检查。

旧会话不能补造刷新令牌，用户须正常登录一次后启用。已有客户浏览器经过正常登录流程进入新版工作台及研究报告；服务器仅核对会话存在刷新令牌、原始授权链及 8 小时截止时间的布尔结果，未导出任何令牌或账号信息。真实连续使用超过一小时仍待观察，不能用自动化时间边界测试或匿名健康检查替代。

本次采用完整镜像，包含此前 main 已合并的 Kimi 模型与工作台导航功能，并保留 PR #99 移除报告资料入口的界面。上线基线已是 `report-sources-off-12d89e8-20261101`。无数据库结构迁移，无角色或 IAM 策略修改，不调整 Cloudflare、TLS、公开端口或其他服务路由。

## 验证

- 本机隔离 PostgreSQL 完整后端 **814 项通过**，相关分支覆盖率 **93.65%**；含两个独立数据库会话竞争同一刷新令牌、只刷新一次的真实行锁测试。
- 合并最新报告界面后的前端 **64 文件、631 项通过**，逐文件覆盖率门槛、TypeScript、构建及门户路由回归通过。
- [PR 最新提交 CI](https://github.com/OpenLimsAI/mb-pm/actions/runs/41312287030) 和 [固定 main CI](https://github.com/OpenLimsAI/mb-pm/actions/runs/41312966766) 五项均通过；未放宽 CI 标准。
- 固定源码归档逐文件与已测试的合并树对比，只有两份并行发布文档不同，业务代码一致。
- 在服务器内将实际生产库 `mb_pm` 备份并恢复到独立临时数据库；候选镜像不发布端口，不挂载生产写卷，关闭两个后台工作器及种子。38 张表记录数与备份基线一致，验收后删除候选容器、临时数据库及临时 env 文件。
- 两个正式实例均 healthy；匿名 `/auth/me`、`/portal/me`、`/solutions` 返回 401，原因码为 `session_missing`，每次请求有独立 `X-Request-ID`。新版恢复资源存在，默认会话参数符合预期。
- 两实例均能读取知识库 **63 篇论文**，笔记准确 Origin 的凭据 CORS 保留，笔记后台同步仍关闭。
- 切换前后的关键业务 ID 保留；38 张表保留统计供核查，允许正常会话和用户新增记录。其他 **15 个容器** ID 未变。
- 公网严格 TLS 检查：工作台健康 200，门户及 PM 匿名身份接口 401 且含新诊断头，知识库健康 200。PM 与知识库第一次连接超时，有时限重试通过；未关闭证书校验或改变访问策略。
- 未调用模型、修改报告正文、发起生成、迁移旧浏览器笔记或删除客户业务数据。生产浏览器验收只检查正常登录及研究报告入口；问题恢复、权限变化、缓存隔离和不自动重发由隔离回归测试覆盖。

## 配置与备份

仅切换 `app`、`app-direct` 的镜像引用。保留以下完整组合及所有客户端、`APP_SECRET`、知识库连接、工作器和日志配置：

1. `compose.yml`
2. `compose.production.yml`
3. `compose.direct.yml`
4. `releases/header-9516977/compose.no-note-sync.yml`
5. `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`

服务器发布目录：`/home/prometheus/mb-pm-v2/releases/session-continuity-e93056d-20261101/`。
私有备份与验收目录：`/home/prometheus/mb-pm-v2/private-config-backups/session-continuity-e93056d-20261101/`，仅保存在服务器受限目录内。包含原 env、完整 Compose、实例 inspect、运行日志、数据库 dump、ID 基线、镜像和候选验证记录；未复制凭据或客户数据库到开发机。

数据库 dump SHA-256：`462366c620f8bc31d4571d875b04eccea9e3ab9d5282dcd2c03546b17c1b7101`。已通过 `pg_restore --list` 及隔离副本恢复验证，明确核对备份目标等于应用实际连接的数据库，未使用默认空库替代。

## 回滚

本次未触发回滚，也未在生产人为演练回滚。服务器发布目录的 `deploy.py` 保存已审查的固定版本脚本。

```sh
python3 /home/prometheus/mb-pm-v2/releases/session-continuity-e93056d-20261101/deploy.py rollback e93056dd1beaae5c982bd516a41a0c59469caf65 a67a8aa737d67113ccf3b564c2a52ca54190d4f4ea48dfafd6aaca0a0cf0a633
```

脚本核对旧镜像 ID，停止两个新实例写入，再通过相同私有网络内的临时 helper，仅将带刷新令牌的新格式会话设为过期，然后恢复旧镜像并检查健康。旧代码不能完整执行新的原始授权链语义，因此这些用户须重新认证。保留撤销标记以及全部报告、笔记和其他业务数据；不恢复或覆盖业务数据库。
