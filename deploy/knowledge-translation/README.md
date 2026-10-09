# 知识库手动翻译与译文持久化

## 功能与源码

知识库是私有 `OpenDIKW/dikw-mbweb` 应用；本目录保存客户恢复补丁和发布工具。
源码基线为 `v0.1.10` / `05a2568fee7db8be7776f5c511a19a6af2fcbf7f`。
`customer.patch` 包含此前企业样式及本次翻译功能，不能叠加到已经应用样式补丁的目录。
当前本地工作目录为 `integrations/dikw-mbweb-customer`（在 PM 仓库外）。
源码归档见 [知识库 PR #18](https://github.com/OpenDIKW/dikw-mbweb/pull/18)。恢复补丁同时包含 CI 静态测试夹具修正，服务运行代码与本次部署版本一致。

- 切换“中英对照”只查已保存译文；没有译文时点击“开始翻译”。
- 完整中文保存在服务器 SQLite，其他有阅读权限的用户 / 浏览器也可复用。
- “重新翻译”成功后才替换旧译文；失败或取消保留原结果。
- 原文内容改变会提示重新翻译；上传不再自动预翻译。
- 离开页面不会取消服务器任务；服务重启后未完成任务需重新开始，已完成译文保留。
- 手机端按段显示原文及中文，避免双栏挤压。

从干净基线恢复，在私有 KB 仓库执行：

```bash
git checkout --detach 05a2568fee7db8be7776f5c511a19a6af2fcbf7f
git apply --check /绝对路径/项目管理系统_Lite-iam/deploy/knowledge-translation/customer.patch
git apply /绝对路径/项目管理系统_Lite-iam/deploy/knowledge-translation/customer.patch
npm ci
npm run lint
npm run format:check
npm test
npm run build
npm run check:bundle
npm run check:gate
```

生产需 Node >=24、现有完整 OIDC / Core / Agent 环境，执行 `npm start`。
必须同时发布 `dist/` 和 `dist-server/`；不能只替换静态目录。
Vite 单独运行不提供本次数据库接口。依赖 / 锁文件未升级。

## 存储与权限

- 文件：`DIKW_AGENT_SESSIONS_DIR/translations.sqlite`；客户容器内为 `/data/mbweb/translations.sqlite`，沿用 `dikw-mbweb-data` 卷，权限 600。
- 表：`paper_translations`，按 issuer / Core、论文路径、语言及格式版本分区，校验规范化原文 SHA-256；只原子写入完整译文，无自动到期清理。
- 接口：GET/POST `/web/papers/translation`，以及任务查询 / 取消。复用现有 BFF 会话校验；POST 核对 Origin，只有任务发起人可取消。
- 同一篇原文的进行中请求合并为一个任务；翻译使用原有服务端 Agent 配置，浏览器不接收密钥。
- 数据库、会话和私密配置不上传 Git；运行中的 SQLite 用在线 backup API 备份，不只复制 `.sqlite` 文件而漏掉 WAL。

## 发布与回滚

发布脚本 `publish.py` 在服务器使用 `prepare <tag>`、`switch <tag>` 两步。
每次准备必须使用新的 `translation-YYYYMMDDTHHMMSSZ` 标签和 manifest。
服务器目录 `/home/prometheus/dikw/translation-releases/<tag>/` 需同时包含源文件、两类构建产物、manifest 与脚本。
manifest 精确记录当前基镜像 ID、旧 / 新 BFF 哈希、package 哈希及每个输入文件哈希；基镜像发生变化时必须重新准备。

`prepare` 备份配置和现有 SQLite，派生当前 KB 镜像以保留精确依赖，并在隔离临时卷检查候选。
`switch` 再检查运行状态，只修改 `.env` 的 `MBWEB_VERSION`，仅重建 `dikw-mbweb`；失败自动恢复前一镜像。
该步骤不更新 PM、IAM、Core、Tunnel 或其他容器。

本次前一镜像为 `dikw-mbweb:maibo-20261008T004840Z`。需要回滚时：

```bash
cd /home/prometheus/dikw
# 只将 .env 的 MBWEB_VERSION 改回 maibo-20261008T004840Z
docker compose -f docker-compose.yml up -d --no-deps dikw-mbweb
```

保留 `translations.sqlite` 及现有卷；旧镜像不会使用新译文表，不需要覆盖客户数据。
备份留在服务器 `translation-backups/<tag>/`，其中私密配置仅留服务器，不能复制到源码目录。
准确上线镜像、备份位置及真实账号待验收见 [发布记录](../parallel-test/releases/20261008-persistent-translation.md)。

## 验收

用有权限的客户账号打开一篇英文论文 → 中英对照：首次应出现“开始翻译”；点击后等完成并显示“已保存”。
刷新或换浏览器后直接显示译文；重新翻译成功后更新，失败 / 取消后旧完整译文仍可阅读。
原文变化应提示重译；匿名访问接口仍为 401，无阅读权限仍被拒绝。
本地真实 BFF / SQLite 测试使用隔离假数据和假模型，不等于客户模型与论文已真实验收。
