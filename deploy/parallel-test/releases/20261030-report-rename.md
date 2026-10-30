# 研究报告名称修改 · 生产发布记录（2026-10-30）

2026-10-30 03:31（America/New_York）发布研究报告列表的修改名称入口。作者可为草稿改名，保存前核对修订，正文、引用和历史版本保留；评审中和定稿的报告仍需返回草稿或创建修订后编辑。

## 固定版本与验证

- 源码：`b432da65d904e732cd8b56aa7592d9da03360b51`，[PR #65](https://github.com/OpenLimsAI/mb-pm/pull/65) 与合并后 main 的全部 CI 通过。候选源码 `fe67096670859f47bb897eb84df5a18c7d3918ab` 的 Git 文件树与 main 一致；归档 SHA-256 `3d51e797ab9fb7cb90c9c5807a364a4dab0c80260f2ea13887d7fcc006ff4f42`。
- 镜像：`mb-pm:report-rename-b432da6-20261030`，ID `sha256:dd3ac72e9552ba3c47bc4de28c5132e02cc29f9132c2c6b19feb0803b5970b1f`；回滚镜像 `mb-pm:report-trash-e86f039-20261030`。
- 仅替换前端静态资源，候选镜像中的后端 Python 文件与之前镜像哈希一致；无数据库结构迁移。只重建 `app` 与 `app-direct`，两者 healthy，内部健康 200、匿名报告 API 401，已确认生产静态资源包含修改入口。
- 本地前端构建和 561 项测试通过；在隔离预览中验证改名、空值、错误、并发冲突和权限。未对真实生产报告改名，真实账号保存操作仍待业务验收。

## 备份与回滚

切换前私有备份位于 `/home/prometheus/mb-pm-v2/private-config-backups/report-rename-final-b432da6-20261030/`；数据库归档 SHA-256 `5054a59e01d3768dd767b49383285700c336df10a298665262db72e31942ba7e`，已验证归档目录可读取。

回滚时确认当前镜像仍为本次版本，将 `.env` 的 `PMS_IMAGE_TAG` 改为 `report-trash-e86f039-20261030`，分别以原有生产及直连 Compose 文件重建 `app` 与 `app-direct` 并复查健康。两个版本均支持回收站；不覆盖数据库、不删除数据卷、不整份恢复旧配置。
