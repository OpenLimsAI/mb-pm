# 2026-10-04 · 知识库入口默认打开论文知识库

www 工作台的「知识库」和项目系统的「相关系统 → 知识库」改为打开 `https://kb.openlims.ai/#mb-web`（论文知识库，MB-Web）。知识库管理工作台仍在 `https://kb.openlims.ai`。同步「版本更新」和独立 HTML 的第 15 条记录。

| 项目 | 值 |
|---|---|
| 上线时间 | 2026-10-04 23:17（Asia/Shanghai） |
| 当前镜像 | `mb-pm:kb-mbweb-20261004T151601Z` |
| 镜像 ID | `sha256:6ad4de73129aa8d2920324be48d00d65cea0e4bb5cccc1fb9716c51f563e6c0c` |
| 回滚镜像 | `mb-pm:portal-20261003T194612Z` |
| 发布快照 | `/home/prometheus/mb-pm-v2/releases/kb-mbweb-20261004T151601Z/`（`dist`、`Dockerfile.frontend-update`、`publish.sh`、`source-state.json`） |
| 发布包 SHA256 | `cde6091252384798ffcf42858a16526c1ed9626321bdcb8a7329981d1878510c` |
| 配置备份 | `/home/prometheus/mb-pm-v2/private-config-backups/kb-mbweb-20261004T151601Z/`，留在服务器 |
| 源码基线 | `b221e1a`（#14） |

## 范围

- 前端：`src/lib/site.ts` 新增 `knowledgeLaunchUrl`，门户跳转页和侧边栏改用它；`knowledgePublicUrl` 不变。
- 只替换静态文件：以线上镜像 `portal-20261003T194612Z` 为基础，`/code/static` 换成本次构建产物。后端、依赖、数据库结构都没有变化。
- 同时把 IAM 应用 `dikw-kb` 的主页地址改为 `https://kb.openlims.ai/#mb-web`（IAM 应用列表的入口），记录在 mb-casd `docs/apps/dikw.md`。

## 验证

- 本地 Node v24.15.0 构建，参数为 `VITE_USE_API=true`、`VITE_API_URL=/api/v1`；`test-portal-routing.mjs`、`tsc -b`、ESLint 通过，PR #14 的 CI 全部通过。
- 候选镜像：运行配置（Env、Cmd、Entrypoint、WorkingDir、User、端口、卷、健康检查）与线上镜像一致；9 个基础层逐层相同，只多出 2 个静态文件层；静态文件包含新链接和第 15 条版本记录。
- 只重建 `app`：15:17:15 开始切换，15:17:28（UTC）healthy，约 13 秒。Casdoor、两个数据库、Tunnel、知识库和 iam-proxy 的容器 ID 与发布前一致。
- 公网：`pm.openlims.ai` 和 `www.openlims.ai` 都返回新入口脚本 `assets/index-DJ7Cb60-.js`，其中包含 `https://kb.openlims.ai/#mb-web`；`/release-notes.html` 包含新记录。
- 知识库（dikw-web 0.11.0）未登录时，会把 `#mb-web` 带进登录的 `returnTo`，IAM 登录后回到论文知识库。已核对匿名请求的跳转脚本。未使用客户账号点击验证完整流程。

## 回滚

把服务器 `/home/prometheus/mb-pm-v2/.env` 中的 `PMS_IMAGE_TAG` 改回 `portal-20261003T194612Z`，其余配置不动，然后执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚只会恢复成不带 `#mb-web` 的知识库链接，不需要回退数据库、Cloudflare 路由或 IAM 主页地址（IAM 主页地址需要的话单独改回）。
