# 回音壁跨应用入口（2026-11-04）

最终版本已部署，服务器核对时间为 `2026-11-04T15:16:22.217067+00:00`（America/New_York 当日 10:16）。知识库、项目管理右上角统一显示「回音壁」。

## 固定版本

| 应用 | 合并源码 | 生产镜像 |
|---|---|---|
| 门户 / 项目管理 | `70e55930372cabae9277b8ddd5a8d36e8f646d6d`（[功能 #161](https://github.com/OpenLimsAI/mb-pm/pull/161)、[命名 #163](https://github.com/OpenLimsAI/mb-pm/pull/163)） | `mb-pm:feedback-entry-70e5593-20261104` |
| 知识库 | `b7a2fa212b99789ab74ede0b71812e1af6009c99`（[功能 #46](https://github.com/OpenDIKW/dikw-mbweb/pull/46)、[命名 #47](https://github.com/OpenDIKW/dikw-mbweb/pull/47)） | `dikw-mbweb:feedback-entry-b7a2fa2-20261104` |

PM 两实例镜像 ID：`sha256:2c57b957ba5b99ff47216606222915725cdf565215560938873c2183ca295961`。
KB 镜像 ID：`sha256:0ccb6b54e7e893c2e875ef1dae038d7ff1680ff5cf1064e664716fc20e3959c8`。

## 使用行为

- 两个模块的公共顶栏均提供「回音壁」；知识库嵌入式资料库也保留入口，窄屏使用图标及明确的可访问名称。
- 在新标签页打开门户 `/feedback?compose=1`，身份及列表加载成功后直接显示提交表单；原页面保留，不增加返回按钮。关闭或提交后清除 `compose`，保留其他查询参数。
- 截图后可在表单按 Ctrl / Cmd + V 粘贴，或选择图片；仍为最多 3 张 PNG / JPEG / WebP、每张 5 MB。普通文字粘贴保留。分类、修复状态和删除权限沿用既有规则。
- 使用固定门户地址及 `noopener noreferrer`，不传递账号令牌、不自动截图或提交。正式环境沿门户登录；显式本地预览继续携带 `preview=1`。

## 构建、配置与数据保留

PM 仅替换 `/code/static`，168 个后端、迁移及锁文件与固定 main 和现网逐字一致。KB 仅替换 `/app/dist`，BFF 与 package 的 2 个运行文件字节一致，Node 依赖沿精确旧镜像保留。均无数据库迁移。

发布从现网容器 labels 动态读取全部配置，PM 保留 24 份、KB 保留 8 份 Compose 后只追加目标镜像覆盖。环境、启动命令、IAM、知识库连接、挂载、网络、安全及资源属性保持原值；共享发布/备份互斥锁、配置哈希和活动任务检查保留。候选镜像及静态文件与固定构建清单一致。

PM 两实例与 KB 均 healthy；PM 以 UID 10001 / 受限数据库角色运行，53 张表及既有记录 ID 保留，助手消息内容与报告、笔记的修订连续性校验通过，模型配置保留。两端各自只读查询 Core 资料目录，返回 331 条记录；未调用模型、修改业务内容或提交生产测试反馈。

## 备份与回滚

所有私有配置及数据副本仅留服务器受限目录。

| 对象 | 证据 / 回滚目标 |
|---|---|
| PM 发布及校验 | `/home/prometheus/mb-pm-v2/releases/feedback-entry-70e5593-20261104/prepared.json`、`rollout/result.json` |
| PM 私有配置和数据库 | `/home/prometheus/mb-pm-v2/releases/feedback-entry-70e5593-20261104/rollout/private-backup/`；`pm-before.dump.gpg` SHA-256 `48ef48372c9aed47a1db8a530936642a37095612e5d9e4ca6b666fa2e99db37a` |
| PM 隔离恢复 | `rollout/private-backup/restore-proof.json`；53 张表成功恢复到无网络、无公开端口的临时 PostgreSQL，校验后已清理 |
| PM 回滚 | 旧镜像 `sha256:e82d583e2d3b3b8336c50a806309ee7457e10def866a360d07ab4f558bd3d80e`；`/home/prometheus/mb-pm-v2/releases/feedback-entry-70e5593-20261104/rollout/rollback-command.json` |
| KB 发布及校验 | `/home/prometheus/dikw/releases/feedback-entry-b7a2fa2-20261104/prepared.json`、`rollout/result.json` |
| KB 数据备份 | `/home/prometheus/dikw/releases/feedback-entry-b7a2fa2-20261104/kb-before.tar.gpg`；SHA-256 `4b6f6d69db35f1086b6d2ec2954e7e6631cc077b3d4854053b13cc233aa93257` |
| KB 隔离恢复 | 8 个 SQLite 在线快照、quick_check、AES256 加密后实际解密到独立副本，并核对文件哈希和各表行数一致；候选不挂生产数据卷，验收容器和临时 env 已删除 |
| KB 回滚 | 旧镜像 `sha256:286bf143882a6737063ea6f90ba784d65179015edb700104d71f74407162fbba`；`/home/prometheus/dikw/releases/feedback-entry-b7a2fa2-20261104/rollout/kb.rollback-image.json` 及 `rollback-command.json` |

回滚前核对没有后续发布及活动任务，使用对应 JSON 中完整 Compose 命令恢复旧镜像。保留数据库、图片及期间新增记录，不用备份覆盖现网，不降级数据库。本次未触发生产回滚。

## 验证与边界

- PM 完整前端 109 文件 / 974 项通过，逐文件覆盖率门槛、相关表单 / 顶栏 15 项、TypeScript、生产构建和路由检查通过。
- KB 完整 86 文件 / 595 项、40 项浏览器 E2E、lint、format、类型检查、构建及 bundle gate 通过；命名后相关 16 项及 40 项 E2E 通过。
- 上述四个代码 PR 的最新提交全部 CI（含后端 PostgreSQL、镜像与安全扫描）通过后才 squash merge；固定源码与本机验证树一致，PM 最终归档额外只含并行发布文档。
- 本地浏览器已验证 PM 入口新开标签并聚焦表单；KB E2E 验证新页无 opener、原 URL 及所选论文保留。截图粘贴及上传的限制、提交和错误恢复由组件回归覆盖。
- 正式服务内部健康 200、匿名接口 401；KB 普通匿名根页 / 静态资源返回 401，浏览器 HTML 请求只提供登录跳转页，OIDC issuer / callback 与账户状态核验保留，未放开静态或业务访问权限。
- 本机公网请求两次超时，独立服务器严格 TLS 公网探测也遇到连接 / HTTP 错误；本次没有据此确认公网或真实登录后的交互验收，也未调整隧道、TLS 或访问策略。生产真实账号点击、粘贴截图、提交成功及切回原页仍待业务验收。
