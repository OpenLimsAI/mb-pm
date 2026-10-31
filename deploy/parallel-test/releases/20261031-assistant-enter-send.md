# 个人助手回车发送 · 生产发布记录（2026-10-31）

个人助手输入框支持 Enter 发送、Shift+Enter 换行；中文输入法组字确认不会触发发送。

## 版本与验证

- [PR #78](https://github.com/OpenLimsAI/mb-pm/pull/78) 全部 CI 通过并合并至 main，源码提交 `508b4380596b07f157d9980a29107c5b54fd7e91`；GitHub 源码归档 SHA-256 `57139c635289b8debb25f3eeabc51ea8e33a0460bfa6bcaa8b376643fbc9e824`。
- 镜像 `mb-pm:assistant-enter-508b438-20261031`，ID `sha256:b7999ad3a4bcc00fdcbc3562ee3ae6631de7c0576f4db4682a5ece5b1b523dda`；沿用旧镜像后端，仅替换前端静态文件。回滚镜像 `mb-pm:assistant-dikw-e294fdc-20261031`；无数据库结构变更。
- 两个实例 healthy，内部健康与助手页面返回 200，匿名助手 API 返回 401；静态资源包含快捷键提示，直连健康及 IAM 检查通过。本机与服务器公网请求超时，公网访问及真实用户发送仍待验收。
- 切换前数据库及配置备份位于服务器 `private-config-backups/assistant-enter-508b438-20261031/`，数据库归档 SHA-256 `d4fd72a973af45621f88ea1ccf261838abd1db77f8579dfadf67839ac43db9aa`，归档目录可读取。

## 回滚

确认当前镜像仍为本次版本后，将服务器 `.env` 的 `PMS_IMAGE_TAG` 改为 `assistant-dikw-e294fdc-20261031`，用现有生产与直连 Compose 文件分别重建 `app` 和 `app-direct`，复查健康。不覆盖数据库或数据卷。
