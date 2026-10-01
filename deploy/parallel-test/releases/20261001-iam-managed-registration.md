# 2026-10-01 · 关闭自助注册上线

## 发布版本

| 项目 | 值 |
|---|---|
| 网站 / IAM | https://pm.openlims.ai / https://iam.openlims.ai |
| 上线时间 | 2026-10-01 23:49（Asia/Taipei） |
| 镜像 | `mb-pm:iam-managed-registration-20261001T154201Z` |
| 镜像 ID | `sha256:a5136e4dff16e7c61c31c8ed0875f1500b29374cef7d0f787407f7be5862ebeb` |
| 回滚镜像 | `mb-pm:visual-refresh-20260928T135928Z` |
| 服务器源码快照 | `/home/prometheus/mb-pm-v2/releases/iam-managed-registration-20261001T154201Z/` |
| 源码包 SHA256 | `51dd50c2feaba8d138bb3107bf23969d925a96296bcf2da4cec074ef598965e9` |
| 源码基线 | 基于 `bcf4569` 的关闭注册源码快照；代码交付见 [PR #11](https://github.com/OpenLimsAI/mb-pm/pull/11)，实际构建输入和逐文件校验清单见快照中的 `source-state.json` |

## 更新内容与构建

- 登录页将「还没有账号？注册新账号」替换为「所有用户信息在iam平台管理」。
- 删除注册表单；旧 `/register` 链接回到 `/login`，`POST /api/v1/auth/register` 固定返回 410，不创建 IAM 或业务账号。
- 移除注册开关和默认角色；旧环境变量不会重新开启注册。IAM 登录与退出流程保留。
- 版本更新页包含 8 条记录；同步发布 `bcf4569` 的任务 / 模板草稿、WBS / 组织刷新及甘特定位修正。
- 后端只更新 `auth.py`、`config.py`、`schemas/account.py`、`services/iam_admin.py`；模型、数据库结构及依赖清单与原线上版本一致。
- 使用 Docker `frontend` 阶段构建，再沿用原运行依赖镜像，完整替换 `/code/app` 和 `/code/static`。实际文件为快照中的 `Dockerfile.application-update`；清理旧静态目录后复制新产物，避免保留旧脚本。

## 备份与验证

数据库备份与私密配置快照仅保存在服务器 `private-config-backups/iam-managed-registration-20261001T154201Z/`，权限受限，不进入 Git。包含 `pms.dump`、`iam.dump`、`app.env`、两份 Compose 配置、切换前容器信息及 `previous-image.txt`。

- TypeScript / Vite 生产构建通过；本次源码此前已通过 ESLint 和 105 项后端测试。
- 在无网络、临时 SQLite 数据库的独立容器中通过 8 项检查：健康、关闭注册配置、注册 API、匿名身份、PKCE 登录与安全 cookie、退出回跳、新登录文案、版本说明。
- 切换后应用为 `healthy`；环境变量按键值、启动命令和挂载卷均一致。两份 Compose 配置未变；项目库、IAM 库、Casdoor 和 Tunnel 容器 ID 未变。
- 公网 `/login`、`/health`、`/release-notes.html`、登录配置返回 200；匿名身份返回 401；注册接口返回 410，提示「所有用户信息在iam平台管理」。
- 浏览器实际确认登录页文案及注册入口移除，并确认访问 `/register` 回到 `/login`。
- 公网 JavaScript、CSS、Logo 和版本说明与本次构建 SHA256 一致。
- 客户服务器发起的公网命令行请求被 Cloudflare 返回 403；从本机及浏览器验证通过。未修改 Cloudflare 安全配置。
- 此次未使用客户账号重跑完整密码登录；未重置账号或密码。服务器 `deployment-result.json` 与 `public-verification.json` 保存实际验收结果。

| 产物 | SHA256 |
|---|---|
| `/assets/index-D_P3n7of.js` | `04b5dac85308eed6d5d90a1f5c5bdd0018ebb32760d19b7ec4b85b73813a7c47` |
| `/assets/index-Dp1QHMT1.css` | `c62be7e064de0747c3d3886d855fac726b17159a4cb3b1e3b35eabe1b660f6d9` |
| `/release-notes.html` | `685bb155527b4620c42335a5618ee51233479f8798a2b3c1792288233418c125` |
| `/brand/maibo-pharma-logo.png` | `bdddcabe5b5d129de79489f449ceb65aaf8eaaa2ee90a9acf2d34e8d64648731` |

## 回滚

将服务器 `/home/prometheus/mb-pm-v2/.env` 中仅 `PMS_IMAGE_TAG` 改回 `visual-refresh-20260928T135928Z`，然后执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚会恢复旧版注册功能。不要整份恢复旧 `.env` 或恢复旧数据库；数据库备份用于数据故障恢复，不是本次镜像回滚的必需步骤。
