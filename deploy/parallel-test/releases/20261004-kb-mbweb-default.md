# 2026-10-04 · 知识库入口默认打开论文知识库

www 工作台的「知识库」和项目系统的「相关系统 → 知识库」改为打开 `https://kb.openlims.ai/#mb-web`（论文知识库，MB-Web）。知识库管理工作台仍在 `https://kb.openlims.ai`。同步「版本更新」和独立 HTML 的第 15 条记录。

| 项目 | 值 |
|---|---|
| 上线时间 | 2026-10-04 23:40（Asia/Shanghai），第二次发布；第一次发布有缺陷，已回滚，见下文「事故」 |
| 当前镜像 | `mb-pm:kb-mbweb-20261004T153942Z` |
| 镜像 ID | `sha256:b20129be52380b243cbde867e1888e0da4576c493ecb5e389bdfaa64766512d3` |
| 回滚镜像 | `mb-pm:portal-20261003T194612Z` |
| 发布快照 | `/home/prometheus/mb-pm-v2/releases/kb-mbweb-20261004T153942Z/`（`dist`、`Dockerfile.frontend-update`、`publish.sh`、`source-state.json`） |
| 发布包 SHA256 | `c22a318ecfd68a4f2c79455f9131f577c23734ae2ab5004a275c048364b76bdd` |
| 配置备份 | `/home/prometheus/mb-pm-v2/private-config-backups/kb-mbweb-20261004T153942Z/`，留在服务器 |
| 源码基线 | `5e0d01e`（代码来自 #14） |
| 入口脚本 | `assets/index-tccJtRhN.js` |

## 范围

- 前端：`src/lib/site.ts` 新增 `knowledgeLaunchUrl`，门户跳转页和侧边栏改用它；`knowledgePublicUrl` 不变。
- 只替换静态文件：以线上镜像 `portal-20261003T194612Z` 为基础，`/code/static` 换成本次构建产物。后端、依赖、数据库结构都没有变化。
- 同时把 IAM 应用 `dikw-kb` 的主页地址改为 `https://kb.openlims.ai/#mb-web`（IAM 应用列表的入口），记录在 mb-casd `docs/apps/dikw.md`。

## 验证

- 构建：本地 Node v24.15.0，`MSYS_NO_PATHCONV=1 VITE_USE_API=true VITE_API_URL=/api/v1 npm run build`。`test-portal-routing.mjs`、`tsc -b`、ESLint 通过，PR #14 的 CI 全部通过。
- 发布前检查（`publish.sh`）：
  - 产物里不含构建机路径，API 地址是 `/api/v1`，并且和线上包一致；
  - 运行配置（Env、Cmd、Entrypoint、WorkingDir、User、端口、卷、健康检查）与线上镜像一致；
  - 9 个基础层逐层相同，只多出 2 个静态文件层；
  - 静态文件包含新链接和第 15 条版本记录。
- 只重建 `app`：15:40:07 开始切换，15:40:20（UTC）healthy。Casdoor、两个数据库、Tunnel、知识库和 iam-proxy 的容器 ID 与发布前一致。
- 浏览器实测（Chrome，账号 hele.hl）：
  - www 工作台加载新入口脚本，门户身份接口正常；
  - 打开 `/launch/kb` 后进入 `https://kb.openlims.ai/#mb-web`，显示论文知识库（46 篇）。
  - PM 侧边栏没有点击验证：该账号没有 PM 角色。不过 pm.openlims.ai 提供的是同一个入口脚本，侧边栏和门户使用同一个常量。

## 事故：第一次发布 API 地址错误（已回滚）

- 第一次发布 `kb-mbweb-20261004T151601Z` 在 Windows Git Bash 里执行 `VITE_API_URL=/api/v1 npm run build`。MSYS 把以 `/` 开头的环境变量值改写成了 Windows 路径，产物里的 API 地址变成了 `C:/Program Files/Git/api/v1`。
- 影响时段：15:17:28 至 15:37:46（UTC，约 20 分钟）。这段时间 pm.openlims.ai 和 www.openlims.ai 的前端无法调用 API，页面提示「无法确认登录身份 / 暂时无法连接工作台登录服务」。后端和数据不受影响。
- 处理：用 Chrome 实测时发现，回滚到 `portal-20261003T194612Z`；随后用 `MSYS_NO_PATHCONV=1` 重新构建，以新标签发布。
- 预防：
  - `publish.sh` 增加两道检查：产物里出现构建机路径就拒绝发布；API 地址必须是 `/api/v1`，并且与线上包一致。
  - 发布后必须用浏览器实际走一遍门户。只用 curl 检查「页面 200 + 包里有新链接」发现不了这类问题。
  - 在 Windows 上构建时，一律设置 `MSYS_NO_PATHCONV=1`，或者改在 Linux / 容器里构建。

## 已知问题（与本次改动无关）

`index.html` 没有返回 `Cache-Control`。浏览器会按启发式规则缓存旧页面，发布后一段时间里，部分用户仍会打开旧前端（本次实测中，新标签页沿用了旧入口脚本）。建议后端对 `index.html` 返回 `Cache-Control: no-cache`，对带哈希的 `assets/*` 设置长期缓存。

## 回滚

把服务器 `/home/prometheus/mb-pm-v2/.env` 中的 `PMS_IMAGE_TAG` 改回 `portal-20261003T194612Z`，其余配置不动，然后执行：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚只会恢复成不带 `#mb-web` 的知识库链接，不需要回退数据库、Cloudflare 路由或 IAM 主页地址（IAM 主页地址需要的话单独改回）。
