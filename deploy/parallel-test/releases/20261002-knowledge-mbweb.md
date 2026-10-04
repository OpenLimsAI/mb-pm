# 2026-10-02 · 论文知识库入口修正

| 项目 | 值 |
|---|---|
| 上线时间 | 2026-10-02 23:54（Asia/Taipei） |
| 当前镜像 | `mb-pm:knowledge-mbweb-20261002T155133Z` |
| 镜像 ID | `sha256:28f4c892d0c9e83be1844ebc7f0bdbc380e9a9ddf46451a37eea10b1a5e71aef` |
| 回滚镜像 | `mb-pm:related-systems-20261002T145304Z` |
| 知识库链接 | https://maibo-dikw.i-am-holo.top/#mb-web |
| 源码快照 | 服务器 `/home/prometheus/mb-pm-v2/releases/knowledge-mbweb-20261002T155133Z/` |
| 源码包 SHA256 | `3379631492731c6ca37c6f816a956aa89d4ab6649bfcd07a420215a56fd8cd84` |
| 源码基线 | `f44a0b058900d39346ffeca2c1d9ad349019977d` 加本地登录页及导航修复，尚未提交；186 个构建输入见 `source-state.json` |

## 修正依据

用户提供的 `#mb-web` 对应专门的论文知识库界面。服务器 `/home/prometheus/dikw/web-src/dikw-web-v0.9.2/src/main.tsx` 根据 hash 在 `MbApp` 与原有 `App` 之间切换；当前知识库首页提供的 `/assets/index-BENvYX0y.js` 同时包含 `mb-web` 路由和「论文知识库」文案。因此，同一域名中有两个前端界面，容器清单不能反映这一页面区别。

项目导航「相关系统 → 知识库」改为完整 `/#mb-web` 地址，保持新标签页、`noopener noreferrer` 和 Cloudflare Access 验证。追加第 12 条更新记录 `knowledge-mbweb-20261002`。

## 验证与部署

- 本地 TypeScript / Vite 构建和 Sidebar ESLint 通过。浏览器用演示数据确认链接 href、target、rel；实际点击新开标签页，Cloudflare 验证跳转保留 `#mb-web`。
- 候选镜像 7 项检查通过。只替换项目应用 `/code/static`，后端及依赖 56 个文件校验与前一镜像一致，不涉及数据库迁移。
- 公网 10 项检查通过，项目首页、脚本、样式、版本说明及 Logo 与候选镜像校验值一致；完整知识库链接包含 `#mb-web`。验收详情保存于 `public-verification.json`，预览截图使用演示数据，仅保存在本机。
- 项目应用为 healthy；运行环境、命令、挂载和两份 Compose 配置不变。项目库、IAM 库、Casdoor、项目隧道，以及知识库相关 6 个容器均保持运行且未重建。
- 服务器 `private-config-backups/knowledge-mbweb-20261002T155133Z/` 保存应用配置及旧容器状态，不含本次数据库备份。构建与上线结果保存在对应源码快照目录。
- 未进行 Cloudflare 邮箱验证码验证，未检查登录后的知识库业务内容。

| 产物 | SHA256 |
|---|---|
| `release-notes.html` | `01509bcad593f27188216785a8445074f9aee74efb4d31e1d7176a10334637cc` |
| `assets/index-DmZOsUmk.js` | `d96a6c8461a48439dfd03da1c319c8718659ff76ac44524b7c400f90f7cf03ba` |
| `assets/index-BFjIb0dm.css` | `19fd42a80a132184f0569297d4ef8899cc8528da9b6de5c2e2b1d25f88c7347b` |

## 回滚

将服务器 `/home/prometheus/mb-pm-v2/.env` 的 `PMS_IMAGE_TAG` 改回 `related-systems-20261002T145304Z`，只重建项目应用：

```sh
cd /home/prometheus/mb-pm-v2
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker inspect mb-pm-v2-app-1 --format '{{.State.Health.Status}}'
```

回滚后知识库链接恢复为网站首页；不要恢复旧数据库或整份配置。
