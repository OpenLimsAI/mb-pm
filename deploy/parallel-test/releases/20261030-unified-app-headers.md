# 应用顶部栏统一 · 生产发布记录（2026-10-30，America/New_York）

项目管理与工作台镜像固定主分支提交 `95169775e5eb8c925e710c657ded229ba99fde87`，包含 [PR #73](https://github.com/OpenLimsAI/mb-pm/pull/73) 与 [PR #74](https://github.com/OpenLimsAI/mb-pm/pull/74)，全部 CI 通过。AI 助手、笔记、研究报告、行业信息和回音壁统一账号与主题入口，应用顶部不再提供退出登录。知识库独立仓库的顶部入口变更未发布，待真实 Core 浏览器验收。

## 发布范围与验证

- 因主分支另含 [PR #72](https://github.com/OpenLimsAI/mb-pm/pull/72)，用户明确允许同时上线其数据库表。启动时创建 `note_wisdom_sync`，不回填旧笔记；新建共享需明确操作。为保持后台同步关闭，两个应用实例通过服务器 `releases/header-9516977/compose.no-note-sync.yml` 覆盖 `NOTES_WISDOM_WORKER_ENABLED=false`。后续发布须继续包含该覆盖文件，直到另行决定启用同步。
- 在无外网的临时数据库副本执行候选版本建表，验证个人笔记数量不变；临时资源已清理。生产切换前备份 `private-config-backups/header-9516977-20261030/database.dump`，SHA-256 `35247433998cca072af037657f6e1ac2f346fbf2c776335ce5fd44f6e71c63ad`。配置和回滚镜像记录位于同一目录。
- 发布镜像 `mb-pm:header-9516977-20261030`，ID `sha256:0367444b58fcb70c7fa78b2a4f78d9e9761606f944f66255bf1f7cf367e5e3c9`。候选源码树与合并提交一致，源码归档 SHA-256 `5cbf75480f8e7d1dd2e6e8f93748fe950fd40a8951077354b4304a7499aac02c`。仅重建 `app`、`app-direct`，两者 healthy。
- 服务器健康返回 200，匿名助手接口 401；公网助手页面与项目健康接口均 200，直连健康、登录页和 IAM 回调检查通过。真实用户和移动端验收待完成。知识库连接配置仍缺失，助手知识库问答未恢复。

## 回滚

将 `.env` 的 `PMS_IMAGE_TAG` 改回 `assistant-5dc6b05-20261030`，分别重建 `app` 和 `app-direct` 并检查健康。保留已创建的数据库表及发布后的数据，不用备份覆盖生产库；不要回滚知识库服务。
