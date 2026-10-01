# 2026-09-28 · 企业标识与界面配色上线

## 发布版本

| 项目 | 值 |
|---|---|
| 网站 | https://pm.openlims.ai |
| 镜像 | `mb-pm:visual-refresh-20260928T135928Z` |
| 镜像 ID | `sha256:27385d7064d9dbc22953090dd496e396b2cf67ab29599465a9a09f3a2ac40556` |
| 回滚镜像 | `mb-pm:release-notes-20260928T060040Z` |
| 服务器源码快照 | `/home/prometheus/mb-pm-v2/releases/visual-refresh-20260928T135928Z/` |
| 源码包 SHA256 | `e39acb8e48597b6c7264e2f0c93304df939254331f0c86bbd420ec16096f7bac` |
| 源码基线 | `c6fa050` 加后续界面改动；此次部署时界面改动尚未提交，以上快照为实际构建输入 |

## 修改

- 左上角替换为用户提供的迈博药业标识。
- 顶部固定为 RGB（35, 72, 111）/ `#23486F`，使用显式 CSS 变量。
- 首页六张组合指标卡片移除彩色底栏，使用白底、深色数字、灰色说明和分隔线。
- 导航、通用卡片、按钮及版本更新页同步改版；AI 分析仍置顶并显示重大升级标签。
- 更新记录增加至 6 条，保留 HTML 下载和打印。

## 部署与验证

使用 Docker `frontend` 阶段构建，再叠加到原线上镜像的 `/code/static`。确认原镜像层、后端依赖和启动配置均保留；只重建应用容器。

- TypeScript / Vite 构建、应用健康检查通过。
- 环境变量按键值比较一致，启动命令和挂载卷一致；数据库、Casdoor、Tunnel 及旧站容器 ID 均未变化。
- 公网 `/`、`/release-notes`、`/release-notes.html`、`/health`、登录配置、CSS、JavaScript 和 Logo 返回 200；匿名 `/api/v1/auth/me` 返回 401。
- 公网静态产物与镜像 SHA256 一致；浏览器实际计算的版本更新页顶栏色为 `rgb(35, 72, 111)`，AI 首位标签可见。
- 浏览器访问应用进入正常 IAM 登录页；此次未使用账号重跑登录后全流程。
- 首次切换时环境变量列表顺序变化触发保护回滚；确认所有键值一致后修正比较方式并重新发布成功。
- 首次公网验证有请求超时，重试后上述检查全部通过。

| 产物 | SHA256 |
|---|---|
| `/assets/index-Dp1QHMT1.css` | `c62be7e064de0747c3d3886d855fac726b17159a4cb3b1e3b35eabe1b660f6d9` |
| `/assets/index-Djc_p_Yq.js` | `01c62e4b0fab0fdff32110ee22e5c59967cae82070eb5e1a0ab0438f8c8446ee` |
| `/brand/maibo-pharma-logo.png` | `bdddcabe5b5d129de79489f449ceb65aaf8eaaa2ee90a9acf2d34e8d64648731` |
| `/release-notes.html` | `0f33fd54c25d54dcc491485fea55568172f870b8a2643e5591529ca4a5f45fa4` |

## 回滚

配置快照留在服务器 `private-config-backups/visual-refresh-20260928T135928Z/`，不下载或提交凭据。

将服务器 `/home/prometheus/mb-pm-v2/.env` 中 **仅** `PMS_IMAGE_TAG` 改回 `release-notes-20260928T060040Z`，然后执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

不要恢复旧数据库或整份旧 `.env`。发布机器上的 `deployment-result.json` 保存本次镜像和校验结果。
