# 2026-09-28 · 版本更新模块上线

## 发布结果

- 站点：https://pm.openlims.ai
- 系统入口：https://pm.openlims.ai/release-notes（登录后使用）
- 独立说明：https://pm.openlims.ai/release-notes.html
- 镜像：`mb-pm:release-notes-20260928T060040Z`
- 镜像 ID：`sha256:436e195a956ef3fc4b7200619473ce5b4dd40a6b924167049af975c04dec28ad`
- 前一镜像：`mb-pm:iam-20260928-ca524d5`
- 服务器发布目录：`/home/prometheus/mb-pm-v2/releases/release-notes-20260928T060040Z`
- 源码基线：`ca524d5` 加版本更新模块改动；构建时尚未提交，源码现随包含 `CHANGELOG.md` 的交付提交归档。

## 本次范围

新增「版本更新」导航和 HTML 说明，包含 5 条历史更新记录；AI 分析置顶并标记「本次重大升级」。
修复 Docker 构建时遗漏 release notes 生成器、内容及样式的问题，并排除整个部署目录，避免运行凭据进入构建上下文。

构建完整镜像验证前端后，将其 `/code/static` 叠加到原线上镜像生成最终发布镜像。最终镜像完整继承原后端和依赖层；仅替换前端静态内容。

只重建 `app` 容器；已核对：

- 应用环境变量、启动命令、持久卷挂载前后一致。
- 项目数据库、IAM 数据库、Casdoor、Tunnel 及旧网站容器 ID 不变。
- 未重新灌入数据库、未执行账号开通或密码修改、未覆盖 AI 配置。
- 旧站点入口的数据迁移/切换不在本次操作范围内。

## 验证

- 服务器端 TypeScript 与 Vite 构建通过。
- 新应用容器健康检查通过。
- HTTPS `/health`、`/release-notes`、`/release-notes.html`、`/assets/index-CTrjqFAz.js`、`/api/v1/auth/config` 均为 200。
- 匿名访问 `/api/v1/auth/me` 为 401。
- 公网 HTML SHA256：`d038ec092ca0a65b8feaad331658dcd172253ccd53c095bb5f05707dc23986bf`，与容器产物一致。
- 浏览器确认线上「版本更新」、AI 分析首位及「本次重大升级」标签。
- 本次未重跑完整账号登录（用户已自行维护账号）；后端及 IAM 配置未变。

Python 默认客户端曾收到公网 403；curl 和浏览器验证通过，未修改 Cloudflare 安全设置。

## 回滚

服务器旧镜像保留。私密配置备份位于 `private-config-backups/release-notes-20260928T060040Z/`，权限受限，不下载到本地。

仅将服务器 `/home/prometheus/mb-pm-v2/.env` 的 `PMS_IMAGE_TAG` 改回 `iam-20260928-ca524d5`，再执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
```

不要恢复数据库，也不要用早期整份 `.env` 覆盖后续用户配置。
