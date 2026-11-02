# DeepSeek 官方搜索 · 生产发布（2026-11-01，America/New_York）

个人助手和研究报告的联网检索接入 DeepSeek 官方 Search，复用本次所选官方模型密钥；Tavily 保留为显式可选服务。普通用户选择 DeepSeek 后正常提问即可，不需要另外申请 Tavily 账号或填写搜索密钥。

## 固定版本

- [PR #113](https://github.com/OpenLimsAI/mb-pm/pull/113) 最新提交五项 CI 全部成功后 squash 合并；固定 main 为 `99ca39d8038dd3fe2a0d0b24247d682f0c186a1f`。
- 镜像 `mb-pm:deepseek-search-99ca39d-20261101`，ID `sha256:81aa41478b2c6a4a45d3bd855c5700d348e4cddc6bb1a48b0caa68bf1c03ed07`，revision 标签与固定提交一致。
- 官方源码包 SHA-256 `b8dfee71bdbe623bcb0f8ef833a425303555fd4a4f6140794af7ce68a8a2458e`；逐项核对 645 个 Git blob 后构建。
- 正式静态构建包 SHA-256 `e3f5e179a94d61b314ed2a0dbfe6cfc207b0d8715215f0069b430bcce466fc2e`；index SHA-256 `3ccd0ae3dd8926e669bfac1d80863f4d5aab451e1f90110b72f85ee908899fef`。
- 发布前及回滚镜像 `mb-pm:knowledge-source-discovery-20261101`，ID `sha256:2ac8687ccb8e2d7bedc487557acac6a2c37107c2870a8c3b31656dc454f32f6b`，源码 `9e8c83976500b86db40a14e82c4cccf1b9fe48c4`。保留并行发布的知识源来源页、NEW 提示、文件夹及界面改动。

完整替换后端与前端；运行依赖清单与前一镜像一致。本次没有数据库迁移、不改模型配置或既有任务内容，仅更新两个应用实例。

## 配置和凭据

生产在原完整六份 Compose 上增加本次 `releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`，仅为 app/app-direct 增加：

```env
ASSISTANT_WEB_ENABLED=true
ASSISTANT_WEB_PROVIDER=deepseek
ASSISTANT_WEB_MAX_RESULTS=5
```

未新增或复制 API Key。企业默认只使用既有企业模型，个人选择只解析当前账号的本次模型。只有 provider=deepseek 且 HTTPS 官方 `api.deepseek.com` 根地址或 `/v1` 可复用；第三方转发地址、缺失/删除的模型不能借用其他配置或把原密钥送到官方。Tavily 需要管理员显式切换，不自动回退。

能力接口按 `model_profile_id` 查询；切换/保存模型、聚焦页面及跨标签保存后刷新状态，过期请求不覆盖新选择。就绪表示满足配置条件，余额或网络失败仍在真实请求中处理。查询只发送公开检索词，不自动附带上下文、任务指引、知识库正文或私有资料；保持固定地址、正文/响应预算和来源引用校验。当前使用 Search 的 need_content=true，不新增任意 URL Fetch。

后续重启使用完整七份配置入口：

```sh
/home/prometheus/mb-pm-v2/releases/deepseek-search-99ca39d-20261101/compose-production.sh ps
```

该目录 `operations.json` 记录精确镜像及覆盖文件。行业信息关闭、知识源手动 worker 开启、笔记同步 worker 关闭、私有知识库连接及日志轮转保持原状；展开配置只改变两个应用镜像和上述三个搜索参数。

## 备份与验证

服务器受限备份为 `/home/prometheus/mb-pm-v2/private-config-backups/deepseek-search-99ca39d-20261101/`，含数据库、运行配置、模型设置、原容器日志、构建日志及验证回执。切换前刷新数据库归档，`pg_restore --list` 通过；归档 SHA-256 为 `f5455639702f5a35143f2e5cc542b2d478735ba8d08235e009cbfaf3738db464`，回执见 `verification.json`。备份不下载或提交 GitHub。

- 本地干净 PostgreSQL 全量 1034 项通过，账号权限覆盖率 93.65%；前端完整 70 文件 706 项及覆盖率门槛通过。TypeScript、修改文件 ESLint/Ruff、门户路由、正式构建和五项 CI 成功。
- 三方合并保留开发期间新合入的知识源功能；重复使用测试库曾产生固定测试记录唯一键冲突，换全新隔离库后完整通过，未因此修改产品代码。
- 官方搜索预检使用既有企业配置返回 HTTP 200，含来源及正文/摘要/日期。完整候选使用生产数据库副本中的本人默认模型，真实执行原公开主题的搜索、模型回答和引用校验，得到 4 条来源与 426 字回答；没有向正式任务写测试记录。
- 首次候选脚本把诊断 JSONL 与最终结果一同解析为单个 JSON，验收读取停止；回答实际上已成功保存在隔离副本。修正脚本后只读恢复该结果，无额外模型调用，所有检查通过后才切生产。
- 两个正式实例均为固定新镜像且 healthy；健康和助手入口 200，匿名助手/能力接口 401；企业及本人默认模型搜索就绪，缺失 profile 不回退。
- 38 张表原有主键全部保留，旧助手消息逐行正文摘要及企业模型设置文件摘要一致；知识库实际目录读取 64 条 source，其他 15 个容器 ID 和镜像未变。
- 本机应急反代 `/assistant`、`/knowledge-sources`、`/login` 返回 200 且 index 摘要一致，匿名能力接口 401。该检查仅在回环使用既有自签名入口，不代表公网证书验收。
- 公网自动探测仍被 Cloudflare 返回 403；未修改边缘安全设置。真实浏览器登录后的点击流程尚未验收，不将源站健康或隔离模型验收冒充浏览器验收。

回执包括 `image.json`、`candidate-verification.json`、`verification.json`。候选容器和数据库已清理，模型设置不变，无新增搜索账户或真实员工测试任务。旧任务缺少项目范围元数据所造成的历史受限问题与搜索未配置不同，本次未调整该权限策略或补造旧来源。

## 回滚

确认当前仍为本次镜像，先导出新增诊断日志，再执行本次目录 `deploy.py rollback`，参数为上述源码包及静态包 SHA-256。helper 仅恢复 PMS_IMAGE_TAG 为知识源发现镜像，并使用发布前完整六份 Compose 重建 app/app-direct，不带入新增搜索覆盖文件；等待 healthy 后复核知识库与助手入口。

保留数据库、任务、联网来源、知识源数据、模型配置及数据卷，不执行 downgrade 或恢复旧业务库。回滚目标已经具备相同的项目历史权限校验和 014/015 字段读取，来源记录不应删除。失败自动保护存在，本次没有在生产执行回滚演练。

本记录为发布后的纯文档归档，经独立 PR、全部 CI 和 squash merge，不再次部署。
