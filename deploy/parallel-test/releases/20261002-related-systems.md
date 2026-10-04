# 2026-10-02 · 相关系统与知识库入口上线

| 项目 | 值 |
|---|---|
| 上线时间 | 2026-10-02 22:56（Asia/Taipei） |
| 当前镜像 | `mb-pm:related-systems-20261002T145304Z` |
| 镜像 ID | `sha256:b626e7ed4b1b938d4a8bd7844ce58f0eca474c3491867887a48798e6ea2c2bed` |
| 回滚镜像 | `mb-pm:iam-login-link-20261002T143414Z` |
| 知识库链接 | https://maibo-dikw.i-am-holo.top |
| 源码快照 | 服务器 `/home/prometheus/mb-pm-v2/releases/related-systems-20261002T145304Z/` |
| 源码包 SHA256 | `7fd8f9c5cba5a052a7cf81ff82eaee9d00e7e8a2b41c80d72c27530176a3611a` |
| 源码基线 | `f44a0b058900d39346ffeca2c1d9ad349019977d` 加本地登录页及导航修复，尚未提交；186 个实际构建输入及校验值见 `source-state.json` |

## 更新与核对

「版本更新」下方新增可展开、收起的「相关系统」菜单，二级链接「知识库」在新标签页打开，使用 `noopener noreferrer`。追加第 11 条更新记录 `related-systems-20261002`。

知识库部署在 `/home/prometheus/dikw`。已清点程序目录，并核对 Compose、Caddyfile、前端配置、源码说明与包版本、Dockerfile、历史部署配置和隧道运行配置中的相关入口：

- 前端来源：`web-src/dikw-web-v0.9.2`，包版本 0.9.2；挂载配置为 `web/config.json`。
- 知识库域名路由：`maibo-dikw.i-am-holo.top → http://dikw-caddy:80`；Caddy 将首页转发到 `dikw-web:4321`，核心服务路由转发到 `dikw-core:8765`。
- 网关本机入口 `127.0.0.1:18080` 返回 200，页面标题为 OpenDIKW。
- 公网入口由 Cloudflare Access 保护，当前显示邮箱验证码登录。未修改访问策略，未执行知识库登录后的文档操作。

## 构建与验证

仅构建前端并替换项目镜像的 `/code/static`，实际文件为 `Dockerfile.frontend-update`。后端及依赖 56 个文件与前一镜像校验一致，不涉及数据库迁移。

- 本地 TypeScript / Vite 构建及 Sidebar ESLint 通过；浏览器用演示数据确认菜单位置、展开 / 收起、链接属性及新标签页打开。
- 候选镜像 7 项检查及公网 10 项检查通过；线上脚本、样式、版本说明、Logo、HTML 与构建校验值一致。
- 项目应用为 `healthy`；运行环境键值、命令、挂载卷及 Compose 配置不变，项目库、IAM 库、Casdoor 与项目隧道容器未重建。
- 知识库前端、两个核心服务、Caddy、原隧道和共享数据库共 6 个容器 ID 不变且持续运行。
- 应用配置备份在服务器 `private-config-backups/related-systems-20261002T145304Z/`，不含本次数据库备份。
- 服务器快照中的 `candidate-checks.json`、`build-summary.json`、`deployment-result.json` 和 `public-verification.json` 保存验收结果。此次未重跑客户账号的完整项目登录。

| 产物 | SHA256 |
|---|---|
| `assets/index-BLGKze9E.js` | `bdd02bcacedfc38fba0001db3e7f3ec0e204d4bd34c55e1313fd81bb84b0156b` |
| `assets/index-BFjIb0dm.css` | `19fd42a80a132184f0569297d4ef8899cc8528da9b6de5c2e2b1d25f88c7347b` |
| `release-notes.html` | `5a1fe97a8c7703eec1744d531162bbc67fe5f1734f1ae65d0268f13d29a2ef2d` |

## 回滚

仅将服务器 `/home/prometheus/mb-pm-v2/.env` 的 `PMS_IMAGE_TAG` 改回 `iam-login-link-20261002T143414Z`，执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚会移除本次导航入口。不要整份恢复旧配置或回退数据库。
