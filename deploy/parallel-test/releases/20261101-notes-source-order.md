# 我的笔记来源排序 · 生产发布记录

发布时间：2026-11-01 03:18 EST（America/New_York）。「按来源浏览」调整为「研究报告 → 知识库 → 行业信息 → 个人记录」，侧栏、窄屏分类和嵌入式来源筛选使用同一顺序。

## 固定版本与范围

- [功能 PR #86](https://github.com/OpenLimsAI/mb-pm/pull/86) 的全部五项 CI 通过后 squash 合并；前端固定 main 源码 `b64c5b7a7c30278679b4b6bc828173f84055fad1`。合并文件树与本地已测试分支一致。
- 发布包 SHA-256：`ed3eefb4bad99348d00b8fb47dedeb46fbde62553a1661b1ca9d70eaae59a900`，使用源码白名单，不包含私密配置。
- 运行镜像：`mb-pm:notes-order-b64c5b7-20261101-r2`；镜像 ID：`sha256:de305c808fbba15dcbcaace23f41a93d2278ad200bed817fc0d213fc86f234a7`。
- 回滚镜像：`mb-pm:assistant-logs-56ef2ed-20261101`；ID：`sha256:a7ffdd498b6438baa10cf6b40d32b9254f09743e5bbc3d1b8d162ad9743b92ea`。
- 仅替换 `/code/static` 并重建 `app`、`app-direct`。后端运行文件和依赖清单与前一镜像哈希一致，无数据库迁移。

## 配置、备份与验证

沿用实际五文件 Compose 组合：`compose.yml`、`compose.production.yml`、`compose.direct.yml`、`releases/header-9516977/compose.no-note-sync.yml`、`releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`。有效配置仅改变两个应用镜像；环境变量、网络和现有日志配置保留，`AUTO_SEED=false`、`NOTES_WISDOM_WORKER_ENABLED=false`。

备份目录：`/home/prometheus/mb-pm-v2/private-config-backups/notes-order-b64c5b7-20261101-r2`，包含数据库、原环境与 Compose 配置、容器信息及 AI 设置。数据库归档 SHA-256 为 `ee948d6fc866f6d5709021e45187c62b816527712c5a6a4d5307ff45c0ca8a3c`，`pg_restore --list` 可读性核对通过；此次没有重复完整恢复演练。私有备份只留在服务器。

- 本地 TypeScript 检查、生产构建、55 个测试文件共 572 项现有测试及覆盖率门槛通过，来源顺序与两个渲染入口已核对。
- 两个应用实例均 healthy，其他 15 个容器 ID 在最终发布前后保持一致，38 张表的记录数一致。
- 两个实际实例的 Core 健康与只读论文目录检查通过，均可读取 63 篇有效论文；未调用生成模型。
- 内部及直连 9 项检查通过；直连使用现有 Caddy CA 验证证书。启动日志未出现检查的错误模式。
- 公网 8 项检查通过，匿名笔记及身份接口返回 401；www / pm 两个入口提供的笔记来源脚本哈希与候选一致，TLS 校验开启。
- 未使用真实员工账号完成浏览器分类点击验收；自动化与资源核对不能替代这一步。

服务器发布目录：`/home/prometheus/mb-pm-v2/releases/notes-order-b64c5b7-20261101-r2/`，保留 `release-receipt.json`、`verification.json` 和 `public-verification.json`。

## 回滚

确认当前仍为本次版本，仅将服务器 `.env` 的 `PMS_IMAGE_TAG` 改回 `assistant-logs-56ef2ed-20261101`，使用上述完整五文件 Compose 组合依次重建 `app`、`app-direct`，等待 healthy 后复查健康、匿名接口与知识库连接。保留现有数据库、配置与数据卷，不整份恢复旧 `.env`。
