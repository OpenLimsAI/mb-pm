# AI 助手任务回收站与知识库统计 · 生产发布记录（2026-10-30，America/New_York）

固定 main 合并提交 `5dc6b05300b038fddc495c931a9c62c485337fbe`，包含 [PR #69](https://github.com/OpenLimsAI/mb-pm/pull/69) 和 [PR #70](https://github.com/OpenLimsAI/mb-pm/pull/70)，两者 CI 均通过。任务可确认删除并恢复，对话与产物保留；增加论文总数统计。

## 发布与验证

- 源码归档 SHA-256 `34e920e194fc031a93252a66ca1284042f060d68e37807b0fce048b0d1e4800b`，镜像 `mb-pm:assistant-5dc6b05-20261030`，ID `sha256:ed07054277502bf5693f98cebc93653754a0252ac10a6902350ac738ef6a78cf`。
- 仅重建 `app` 和 `app-direct`，均 healthy；无数据库迁移。配置备份及原镜像记录位于服务器 `private-config-backups/assistant-5dc6b05-20261030/`。
- 服务器内部健康与助手页面返回 200，匿名助手 API 返回 401；直连健康、IAM 登录页及回调检查通过。本机公网助手页面返回 200，PM 健康及公网匿名助手接口检查遇到 SSL 连接超时。真实账号删除和恢复待验收。
- 知识库连接未配置，本次没有改动该配置；AI 助手知识库问答及论文计数仍不可用，真实数据访问待连接和验收。

## 回滚

将服务器 `.env` 的 `PMS_IMAGE_TAG` 改回 `assistant-1db6705-20261030`，使用现有生产与直连 Compose 分别重建 `app` 和 `app-direct` 并复查健康；不覆盖数据库或其他配置。
