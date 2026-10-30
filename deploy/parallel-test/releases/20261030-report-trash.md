# 研究报告回收站 · 生产发布记录（2026-10-30）

2026-10-30 02:42（America/New_York）发布研究报告删除与恢复功能。作者在报告卡片确认后可将本人报告移入回收站，并从列表的回收站恢复；正文、引用、版本和问答历史保留，评审者在此期间不能访问，已发布的独立资料不受影响。本次 main 同时包含 [PR #62](https://github.com/OpenLimsAI/mb-pm/pull/62) 的甘特图更新。

## 固定版本

- 工作台源码：`e86f0398ca886c7898170e28cce41b5694abf8cc`，[PR #63](https://github.com/OpenLimsAI/mb-pm/pull/63) 与 main 的全部 CI 通过。候选源码包来自 `a53b9dda94d39d304f17779f01b36496ad95b56a`，Git 文件树与合并提交一致；归档 SHA-256 `96820898329889cbeaac20c5c09f55b36366bb0c484c8eeb083e102af1e70eb3`。
- 镜像：`mb-pm:report-trash-e86f039-20261030`，ID `sha256:c8c6384bd9da08fa0c5641eeadb33c6a965612719ba9984a8acc8fa0319a4dff`；仅重建 `app` 与 `app-direct`。此前镜像为 `mb-pm:research-workspace-dcd3145-20261029`；知识库未更新。

## 验证与备份

在无公网隔离环境恢复生产数据库候选备份，升级前后原有 37 张表的旧列与行哈希一致，使用合成报告验证移入回收站、访问限制及恢复。切换前私有备份位于服务器 `/home/prometheus/mb-pm-v2/private-config-backups/report-trash-final-e86f039-20261030/`；PM 数据库归档 SHA-256 `118da751b1269f00b6e6dc27ca1174d1ddd59d607f49073b7c1ea05b5fb53124`，已验证归档目录可读取。

切换后两个实例 healthy，内部健康 200、匿名回收站请求 401，旧表新增可空字段与前端资源均已核对。真实登录浏览器的新标签可访问生产报告列表，原有报告仍在，其卡片出现删除按钮，页面出现回收站；未删除或修改真实报告。实际员工删除并恢复报告的业务验收仍待完成。

## 回滚

回滚前检查 `knowledge_solutions.deleted_at`：**旧镜像不识别回收站字段，回滚后已删除报告可能重新出现在列表中。** 若已有回收站记录，先协调数据与访问方案，不能直接切换旧镜像。确认安全后将服务器 `.env` 中 `PMS_IMAGE_TAG` 改回 `research-workspace-dcd3145-20261029`，使用现有生产及直连 Compose 文件分别重建 `app`、`app-direct` 并检查健康。保留数据库中的新字段、记录和数据卷，不用旧备份覆盖上线后业务写入。自动回滚在发现回收站记录或无法检查时会停止并要求人工处理。
