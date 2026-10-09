# 2026-10-08 · 知识库手动翻译与中文持久化（已部署）

入口：[kb.openlims.ai](https://kb.openlims.ai/)。北京时间 / 台北时间 2026-10-08 发布。

## 用户变化

- 进入“中英对照”不再自动调用模型；首次点击“开始翻译”。
- 中文完整生成后保存在服务器，下次打开或换浏览器直接读取；同一知识库的授权读者共享译文。
- “重新翻译”仅在成功时替换旧结果，失败 / 取消保留旧中文。
- 原文变化提示重新翻译；上传不再自动预翻译。离开页面不取消服务器任务；重启后未完成任务需重开。
- 手机按段显示英文与中文，按钮可完整显示。

## 部署与备份

| 项目 | 值 |
|---|---|
| 当前镜像 | `dikw-mbweb:translation-20261008T012722Z` |
| 镜像 ID | `sha256:471753ef3bfba3936a4a06852dfa3cb330f1634cd756a03e02d41239779577d1` |
| 前一镜像 | `dikw-mbweb:maibo-20261008T004840Z` |
| 源码基线 | 私有 `OpenDIKW/dikw-mbweb`，v0.1.10 / `05a2568fee7db8be7776f5c511a19a6af2fcbf7f` |
| 输入、源码及检查记录 | `/home/prometheus/dikw/translation-releases/translation-20261008T012722Z/` |
| 保护备份 | `/home/prometheus/dikw/translation-backups/translation-20261008T012722Z/` |
| 译文数据库 | `dikw-mbweb-data` 卷内 `/data/mbweb/translations.sqlite` |
| 新 BFF SHA-256 | `4519836416690afa2a5bee98e4ae8c28489ea4862ca75467b3971b50e4becdcf` |

发布同时替换 `/app/dist` 与 `/app/dist-server`，保留原精确依赖和运行镜像环境。
只修改 `.env` 的 `MBWEB_VERSION`，仅重建 `dikw-mbweb`。其余 10 个容器 ID、运行环境变量值和挂载均不变；未修改 PM、IAM、Core、Tunnel 或知识文件。

切换前已在线备份 `auth.sqlite` 和 `agent.sqlite`，原配置 / Compose / 容器私密环境只留服务器，权限受限。
新译文数据库开机创建 `paper_translations` 表，权限 600、完整性检查通过；以后发版也需在线备份该文件。
`manifest.json` 保留 286 个输入文件哈希及 JS / CSS / Logo 哈希，正式容器内容与其一致。

第一轮候选因源码 `.dockerignore` 排除构建产物而构建失败，未切换生产。
发布工具补充 Dockerfile 专用忽略规则，只允许两个已验证产物目录，使用新标签 / 新备份后通过。
首次未采用的标签 `translation-20261008T012544Z` 仅保留失败准备记录和备份，不能视作上线版本。

## 验证范围

- 本地 37 个测试文件 / 215 项通过；lint、format、TypeScript、前后端构建、bundle / gate 检查通过，恢复补丁可干净应用到基线。
- 用真实 shared BFF 和隔离假 Core / 假模型 / 假会话验证：只显式翻译一次，跨读者复用，完整运行时关闭 / 重启后仍读 SQLite；覆盖原文变更、不完整结果、失败、取消、权限和 Origin。未调用客户付费模型。
- 浏览器核对桌面及 390×844 手机；用明确标注的演示论文确认“开始翻译”、保存后“重新翻译”和刷新复用，手机原文 / 中文分段显示。
- 隔离候选和正式入口 `/healthz` 为 200，容器 healthy；匿名论文、新译文接口和静态资源保持 401；管理合成接口仍 403。
- 原 OIDC 客户端 `dikw-4b017ecb75a7ae01`、`https://kb.openlims.ai/web/auth/callback` 和 PKCE S256 保留。
- SQLite 表、权限和完整性通过；完整 coverage / e2e 未运行。**本次未用客户真实账号和论文调用在线模型；业务翻译质量、费用与真实跨设备体验仍待验收。**

## 回滚与验收

将 `/home/prometheus/dikw/.env` 中 `MBWEB_VERSION` 改回 `maibo-20261008T004840Z`，运行：

```bash
cd /home/prometheus/dikw
docker compose -f docker-compose.yml up -d --no-deps dikw-mbweb
```

保留所有数据卷及新增译文表，不覆盖知识库或 IAM 数据。
客户验收：英文论文 → 中英对照 → 开始翻译 → 等待“已保存” → 刷新 / 换浏览器读取 → 重新翻译。
再验证取消 / 失败保留旧中文，原文修改提示重译。只有翻译配置可用且账号有阅读权限时才能发起；读取已保存结果不再调用模型。

源码恢复、存储、后续发布详见 [维护说明](../../knowledge-translation/README.md)。
PM 仓库更新 HTML 已生成，本次没有重建 PM 来发布该说明。

## GitHub 源码归档补充（2026-10-09）

知识库源码提交至 [私有 KB PR #18](https://github.com/OpenDIKW/dikw-mbweb/pull/18)，发布 / 维护记录提交至 [PM PR #19](https://github.com/OpenLimsAI/mb-pm/pull/19)。
本地覆盖率检查通过：statements 72.46%、branches 66.05%、functions 73.19%、lines 74.92%。
CI 发现新集成测试依赖先前构建的 `dist/index.html`，已改成独立临时静态文件并保留断言；恢复补丁同步更新。此修正只涉及测试，不改变已部署服务代码，无需重复上线。
CI 与合并结果以对应 PR 为准，未改检查门槛或工作流。
