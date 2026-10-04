# 2026-10-02 · IAM 登录页链接修正上线

| 项目 | 值 |
|---|---|
| 上线时间 | 2026-10-02 22:36（Asia/Taipei） |
| 登录页 / 链接目标 | https://pm.openlims.ai/login / https://iam.openlims.ai/login |
| 当前镜像 | `mb-pm:iam-login-link-20261002T143414Z` |
| 镜像 ID | `sha256:116f7916961d823dbdd219ad6897c506402f9c9fb06fb4efca019e8c2235edff` |
| 回滚镜像 | `mb-pm:iam-platform-link-20261002T115012Z` |
| 服务器源码快照 | `/home/prometheus/mb-pm-v2/releases/iam-login-link-20261002T143414Z/` |
| 源码包 SHA256 | `b1589fbcf3e6ba2ca50e16d5f78f193e4b73ce799677e7c73fe9b2415d559e11` |
| 源码基线 | `f44a0b058900d39346ffeca2c1d9ad349019977d` 加本地 IAM 链接修复；修复尚未提交，186 个实际构建输入及校验值见 `source-state.json` |

登录页底部「IAM 平台」的链接从域名根地址改为明确的 `/login` 地址，保留新标签页打开与 `noopener noreferrer`。追加第 10 条版本记录 `iam-login-link-20261002`。

仅使用 Docker Node 20 构建前端并替换 `/code/static`，实际构建文件为 `Dockerfile.frontend-update`。后端及依赖 56 个文件校验值与前一镜像一致，不涉及数据库迁移。

- 本地 TypeScript / Vite 构建、登录页 ESLint 检查通过。
- 候选镜像 6 项检查通过；公网 9 项检查通过，包括页面、健康、登录配置、匿名身份、IAM 登录地址及静态文件。
- 浏览器确认实际 `href=https://iam.openlims.ai/login`，点击后在新标签页打开 IAM 登录表单。
- 线上应用为 `healthy`；环境变量键值、启动命令、挂载卷、两份 Compose 配置均保持一致。项目库、IAM 库、Casdoor 和 Tunnel 容器 ID 未变。
- 配置备份在服务器 `private-config-backups/iam-login-link-20261002T143414Z/`，仅包含配置及容器信息，本次未另做数据库备份。
- 服务器源码快照中的 `candidate-checks.json`、`build-summary.json`、`deployment-result.json`、`public-verification.json` 保存验证结果。未使用客户密码重跑完整业务登录。

| 产物 | SHA256 |
|---|---|
| `assets/index-heSy8F3B.js` | `c541e28ad70995135d3e2bdd3f163bb8110a9f414d3ba9551cfdb0a43b83fed4` |
| `release-notes.html` | `ee856171c04d12fef73f4bfdf21334934df5fef694dad0033f2685851103c1ee` |

回滚时仅将服务器 `/home/prometheus/mb-pm-v2/.env` 的 `PMS_IMAGE_TAG` 改回 `iam-platform-link-20261002T115012Z`，执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚会恢复域名根地址链接。不要整份恢复旧 `.env` 或回退数据库。
