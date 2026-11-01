# 知识库统一服务端笔记 · 生产发布（2026-11-01）

日期按 America/New_York。发布源码为已 squash 合并的 [dikw-mbweb #35](https://github.com/OpenDIKW/dikw-mbweb/pull/35)，固定提交 `8d0650391ea02ba9d6707fef9c5c92e4b7de4861`；其 [main CI](https://github.com/OpenDIKW/dikw-mbweb/actions/runs/41221126958) 全部通过。

## 版本与范围

- 镜像：`dikw-mbweb:shared-notes-8d06503-20261101`；精确 image ID `sha256:36ac8d5095ada335115d00f046d7c6888cd590964a86dcef43b5d86f137c46cf`，OCI revision 为上述固定提交。
- 源码归档 SHA-256：`4680ecd53e73d1518804773ac6d0e6ec5b3645eb67a1070734482d6e91d6659d`。按现有客户本地镜像方式在服务器独立构建，使用提交的 lockfile、Node 24 和原 Dockerfile，并刷新 runtime 安全更新；没有宣称发布 GHCR 镜像。
- 统一笔记前端上线：知识库嵌入门户笔记界面，新摘录和问答笔记直接保存到同一账号的门户服务端。旧浏览器笔记不读取、不迁移、不删除。
- 只更改知识库 `.env` 的 `MBWEB_VERSION` 并重建 `dikw-mbweb`。环境、既有卷、CA 绑定、网络、路由、IAM 和 Core 保持原配置；不新增端口、角色、依赖或数据库迁移。
- 门户已有统一笔记配套接口。两个 PM 实例的知识库连接复核正常；笔记 Wisdom worker 继续关闭，未配置或启用后台检索副本同步。

## 备份与安全扫描

服务器私有发布目录为 `/home/prometheus/dikw/releases/shared-notes-8d06503-20261101/`，备份在其 `backup/`，根目录权限 0700；配置与数据库仅在服务器保存。

7 个 SQLite 数据库使用 Node SQLite online backup，逐库 quick_check 通过；配置、应用运行快照和其余运行文件一并保留。门户 PostgreSQL 与 Core 实际业务库 `dikw_v06` 的归档经 pg_restore 清单验证，Core 库包含 15 张业务表。共记录 24 个备份文件指纹。

- `core.dump`：`5f6659a13de830766f9c120f2fb75002cbdcccc8ae7dcb83b8785f471d2b934c`。
- `portal-notes.dump`：`a7ab834f03b985a1992ec46deecfdd7bdcf254e6d9af0bb0aed34d60b0533cfa`。

Trivy 0.76.1 官方容器固定 digest `sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c`，扫描精确镜像归档；按原有 HIGH/CRITICAL + ignore-unfixed 规则，两项均为 0。默认 DB 镜像源停滞后改用官方 GHCR 数据库，未跳过扫描或降低门槛。报告留在 `reports/trivy.json`。

## 隔离验证与生产切换

候选使用生产环境配置、原有三个网络和隔离的数据副本。进程健康、OIDC 登录跳转与原回调地址、匿名身份/论文 401、维护入口 403、63 篇 Core 论文读取及统一笔记静态资源均通过。两个门户实例的精确知识库 Origin CORS、匿名笔记 401 和知识库连接通过。

最初的部署检查错误预期匿名身份接口返回已登录元数据；核对共享认证代码后修正为其实际 401 契约。应用代码与 CI 门槛未改变。

第一次切换的挂载检查将 Docker 的展示顺序变化误判为卷变化，自动恢复原镜像并验证健康；数据库和卷未回退。改为按实际 source、name、destination 和读写标志核对后，第二次切换成功。自动镜像回滚路径已实际演练。

成功切换窗口内只重建知识库容器，卷、配置与网络语义一致。期间门户由其他发布任务升级，最终另行复核其两个实例的笔记接口和知识库连接，未用旧镜像覆盖这些并发更新。

## 验收与边界

- 生产知识库 healthy；实际容器 OIDC 模式开启，匿名论文 API 401、维护入口 403，Core 有效论文 63 篇，统一笔记构建资源存在。
- 公网知识库 `/healthz` 200、匿名论文 API 401；门户笔记嵌入页面 200。TLS 校验均通过；一次公网健康请求连接超时，有限重试后通过。
- 启动日志未观察到 uncaught、unhandled、fatal 或 startup failed 模式。
- 本轮没有调用生成模型、上传/删除论文或写入客户笔记，没有自动处理旧浏览器数据。
- 用户已同意保留真实账号验收待补。两应用以同一真实账号登录后的新摘录保存、编辑、回收站及跨应用展示仍需补验，不能以隔离夹具或服务端连接验收代替。

## 回滚

保留镜像 `dikw-mbweb:header-41fe005-20261030`，image ID `sha256:56de737b61ac9317e03f0b44ee4b82d1fcbf74cb5f16122336d95f772002c992`。仅将知识库 `.env` 的 `MBWEB_VERSION` 改回该 tag 并重建 `dikw-mbweb`，保留所有卷、数据库、译文、标签和新笔记。不用旧数据库快照覆盖新业务记录。回滚后的旧知识库界面不展示新的统一笔记，门户独立笔记入口仍保留服务端记录。
