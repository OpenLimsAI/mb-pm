# 2026-10-02 · 登录页 IAM 平台入口上线

| 项目 | 值 |
|---|---|
| 登录页 / IAM | https://pm.openlims.ai/login / https://iam.openlims.ai |
| 上线时间 | 2026-10-02 19:57（Asia/Taipei） |
| 当前镜像 | `mb-pm:iam-platform-link-20261002T115012Z` |
| 镜像 ID | `sha256:cdd071dcf3674a2f23d94ce41721d1c0627e2fbb30c3d626dca60f74a94ff2ee` |
| 回滚镜像 | `mb-pm:iam-managed-registration-20261001T154201Z` |
| 服务器源码快照 | `/home/prometheus/mb-pm-v2/releases/iam-platform-link-20261002T115012Z/` |
| 源码包 SHA256 | `30757b6ebb7a1fe4c68758562faf40785a0d381ae87c71155ab06b7f1198f1e9` |
| 源码基线 | `f44a0b058900d39346ffeca2c1d9ad349019977d`（PR #11 合并后的 `main`）加本地 IAM 链接修复；修复尚未提交，实际 186 个构建输入及校验值见快照中的 `source-state.json` |

## 更新内容与构建

- 登录页提示改为「所有用户信息在 IAM 平台管理」，统一使用大写 IAM。
- 「IAM 平台」链接到 `https://iam.openlims.ai`，在新标签页打开，带 `noopener noreferrer`。
- 追加第 9 条「版本更新」记录 `iam-platform-link-20261002`，同步独立 HTML 说明。
- 使用 Docker Node 20 前端阶段构建，沿用前一应用镜像，仅替换 `/code/static`；实际构建文件为快照中的 `Dockerfile.frontend-update`。
- 后端及依赖 56 个文件校验值一致：`d5256c9a394ae8ffe2a660b91bfd3938c4459dd55e23ae05348c9dbd1545c763`。不涉及数据库迁移。

## 备份与验证

配置备份位于服务器 `private-config-backups/iam-platform-link-20261002T115012Z/`，权限受限，不进入 Git。包含 `app.env`、两份 Compose 配置、切换前容器信息和 `previous-image.txt`；本次前端发布未另做数据库备份。

- TypeScript / Vite 生产构建及登录页 ESLint 检查通过。
- 独立候选容器通过 6 项检查：健康、关闭注册配置、匿名身份、注册 API 返回 410、编译后 IAM 链接、最新版本说明。
- 线上应用为 `healthy`；环境变量按键值、启动命令和挂载卷保持一致，两份 Compose 配置未变。项目库、IAM 库、Casdoor 和 Tunnel 容器 ID 未变。
- 公网登录页、健康、登录配置、版本说明及 IAM 页面返回 200，匿名身份返回 401；公网 HTML、JavaScript、CSS、Logo 和版本说明 SHA256 与候选镜像一致。
- 浏览器在正常 `/login` 地址确认完整文案、链接目标及新标签页打开 `https://iam.openlims.ai/login`。
- 未使用客户密码重跑完整业务登录。服务器快照内 `candidate-checks.json`、`build-summary.json`、`deployment-result.json`、`public-verification.json` 保存实际验证结果。

| 产物 | SHA256 |
|---|---|
| `/assets/index-C-HXqr9S.js` | `49cff86df3b148a7192e30ae1cb66e18ef4a30bbd4437afa47688a44ea8127c6` |
| `/assets/index-DexWm8Pi.css` | `e64be57d5170e15fee4320ebad8f294d7b1c78b7abaaab53c88ce5a5ebdf0f07` |
| `/release-notes.html` | `6cfd8b4ab9c74f411bc45a8378fcdf04f00a1b01b30bb55450cb703bde7381d0` |

## 回滚

仅将服务器 `/home/prometheus/mb-pm-v2/.env` 的 `PMS_IMAGE_TAG` 改回 `iam-managed-registration-20261001T154201Z`，然后执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚后登录页恢复旧的小写提示，但仍关闭自助注册。不要整份恢复旧 `.env` 或回退数据库。
