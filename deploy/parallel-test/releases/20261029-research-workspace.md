# 研究工作台与知识库生产发布（2026-10-29）

## 范围与版本

- 生产切换约为 2026-10-29 23:56（America/New_York）。工作台包含研究报告、独立笔记、行业信息、AI 助手及知识库嵌入界面；知识库提供相应的嵌入视图。
- 工作台源码固定为已合并且 main CI 全部通过的 `dcd3145f954baed306f4c9352da48dffb950ff13`（[功能 PR #59](https://github.com/OpenLimsAI/mb-pm/pull/59)、[升级兼容 PR #60](https://github.com/OpenLimsAI/mb-pm/pull/60)）。服务器构建包来自 `9fd20162278208bae0aee78c79944e55d5bb6bb9`，其 Git 文件树与该 main 提交完全一致；归档 SHA-256 `6fe7b6a4dcc9f27b42be0b4a6316d4e5a33540b006e58b2e9c43e1aa7f08b6cc`。
- 工作台镜像 `mb-pm:research-workspace-dcd3145-20261029`，ID `sha256:c3b9cc3528e2d0547b0119777c7009a60b8f5a85a20809b0e81e85379937f3d0`；同时更新 `app` 和 `app-direct`。回滚镜像 `mb-pm:feedback-delete-b252b3f-20261027`。
- 知识库源码 `dc93d8e977eb06c559c23762d545c57708739ba5`（[PR #34](https://github.com/OpenDIKW/dikw-mbweb/pull/34)，main CI 通过），归档 SHA-256 `0bc5c2f82dbc9c6822966f37c019b4c49552a1cc06bda831bf70d6a124d5aedc`。镜像 `dikw-mbweb:research-workspace-dc93d8e-20261029`，ID `sha256:ad767e9ccaa0945cb8d126ccc5d241317a263c9994f7593f4db1353236bdcacf`；回滚镜像 `dikw-mbweb:information-live-20261023T181528Z-pdf`。

## 备份与验证

服务器私有备份位于 `/home/prometheus/mb-pm-v2/private-config-backups/integration-final-20261029-dcd3145-dc93d8e/`：切换前 PM 和 Core PostgreSQL 归档、Core 文件、两个应用配置及知识库各 SQLite 在线备份。PM 归档 SHA-256 `cac66d043241c8e81ce22cc9c9bc8ec32587cf03ad922f3c92bc5fa334587c08`；Core 归档 `e7f0e62c5da97797091590e9785d765d2b131feebeb253a3c2f5e7045eb2e1d3`。归档目录可读取，SQLite 完整性检查通过；此外先前候选备份包含 PM 两个数据卷。

生产库先前缺少 `solution_answers.conversation_id`。候选镜像在无公网的生产库备份副本启动，升级前后对 33 张既有表的原有列和行逐表计算哈希，数据一致；重复升级通过。新增可空字段和索引以及笔记、助手与模型设置表已在生产确认存在。生产切换后的三个实例均 healthy；内部健康返回 200，匿名报告 API 和知识库 API 返回 401，近期启动日志无错误。知识库构建镜像使用 Trivy 0.70.0 和 2026-10-30 漏洞数据库扫描，无可修复 HIGH/CRITICAL；知识库候选使用独立数据副本及测试配置在无网络容器内验证启动和匿名拒绝。

**验收限制：** 发布前后本机对公网域名的访问超时，服务器本地入口可用；未能确认公网浏览器端到端访问。未使用真实员工账号验证登录、嵌入、问答或模型供应商。生产 `SOLUTION_KB_*` 连接未配置，因此报告问答不能读取企业论文；原知识库自身的浏览与管理不依赖该连接。个人 AI 需要用户自行配置模型，尚未进行真实模型调用。不得将健康检查解释为上述功能已验收。

## 回滚

确认当前仍运行本次镜像后，仅把 `/home/prometheus/dikw/.env` 中的 `MBWEB_VERSION` 改为 `information-live-20261023T181528Z-pdf`，并在该目录执行 `docker compose up -d --no-deps --force-recreate dikw-mbweb`。将 `/home/prometheus/mb-pm-v2/.env` 中的 `PMS_IMAGE_TAG` 改为 `feedback-delete-b252b3f-20261027`，分别以现有的 `compose.yml`、`compose.production.yml` 和直连 `compose.direct.yml` 重建 `app`、`app-direct`，核对三个容器健康及匿名鉴权。不要恢复整份旧 `.env`、删除卷或用切换前备份覆盖上线后产生的业务数据；新增表和可空列保留。
