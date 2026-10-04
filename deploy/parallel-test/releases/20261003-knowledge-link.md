# 2026-10-03 · 知识库链接切换到新域名

「相关系统 → 知识库」改为 `https://kb.openlims.ai`，保留新标签页及 `noopener noreferrer`。同步系统「版本更新」和独立 HTML 的第 13 条记录；本次记录入口调整，知识库自身的登录回跳和用户准入另行验收。

| 项目 | 值 |
|---|---|
| 上线时间 | 2026-10-03 17:08（Asia/Taipei） |
| 当前镜像 | `mb-pm:knowledge-link-20261003T090717Z` |
| 镜像 ID | `sha256:f755366926d759a224a2a1e15c9802b14dc43bbddee04459a77be9e40a939698` |
| 回滚镜像 | `mb-pm:knowledge-mbweb-20261002T155133Z` |
| 发布快照 | `/home/prometheus/mb-pm-v2/releases/knowledge-link-20261003T090717Z/` |
| 发布包 SHA256 | `89b5b33bfc150cd328c4d186c3edc52349348f2e77b8db6ae65deba0b61b38ae` |
| 配置备份 | `/home/prometheus/mb-pm-v2/private-config-backups/knowledge-link-20261003T090717Z/`，留在服务器 |
| 源码基线 | `f44a0b058900d39346ffeca2c1d9ad349019977d` 加本地前端修复，尚未提交；128 个前端构建输入及校验值见 `source-state.json` |

## 验证与范围

- 本地 Node v26.4.0 构建，`VITE_USE_API=true`、`VITE_API_URL=/api/v1`；TypeScript、Vite 构建和 Sidebar ESLint 通过。
- 从当前线上镜像继承运行层，只替换 `/code/static`。候选 8 项校验通过：新知识库导航 URL、旧导航移除、外链保护、IAM 链接保留、准确的更新说明、静态文件清单、后端及依赖一致、镜像运行配置一致。
- 线上内网 9 项检查通过，包含健康、首页、登录页、说明页、JS / CSS、Logo、匿名身份 401 和认证配置；响应静态文件 SHA256 与发布包一致。
- 正常公网浏览器确认新版更新说明和新域名文案；PM 登录页实际引用 `/assets/index-Ch5rLZZ-.js`，IAM 平台链接仍为 `/login`。未使用客户账号验证登录后的导航点击或知识库业务内容。
- 运行环境按键值比较，启动命令、挂载、端口和网络保持一致；后端文件及依赖校验一致。项目库、IAM 库、Casdoor、Tunnel、知识库前端 / 核心 / Caddy 的容器 ID 与本次发布前一致。
- 首次候选因环境变量列表排列顺序不同触发保护并自动回滚；修正为键值比较后重新发布，仍要求所有配置值一致。当前项目服务 healthy。
- 本机浏览器预览受已保存权限设置阻止；公网直接打开原始 JS 请求被客户端拦截。验证依据为线上页面状态、实际脚本引用，以及服务器响应的文件校验值。

| 产物 | SHA256 |
|---|---|
| `assets/index-Ch5rLZZ-.js` | `b8ac562eeff89beaf9e7f51165da8b9711184371c27ad49040e06e06320e1594` |
| `release-notes.html` | `0a38cef61b533aeb1d33802c7e2efb97bbfc833d85f0aac6c5e68a59ad3a0228` |
| `assets/index-BFjIb0dm.css` | `19fd42a80a132184f0569297d4ef8899cc8528da9b6de5c2e2b1d25f88c7347b` |

发布快照保存 `publish.py`、`Dockerfile.frontend-update`、`candidate-checks.json`、`static-manifest.json` 和 `deployment-result.json`。构建源码位于其 `source/`，仅含前端；本次未修改后端或数据库结构。

## 回滚

仅将服务器 `/home/prometheus/mb-pm-v2/.env` 中 `PMS_IMAGE_TAG` 改回 `knowledge-mbweb-20261002T155133Z`，保留其余配置，再执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚恢复 PM 的旧知识库链接；不需要回退数据库、IAM 应用或 Cloudflare 路由。
