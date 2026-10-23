# 信息获取真实服务 · 2026-10-23

本次将 ICH 真实服务部署至客户生产系统。入口：[信息获取](https://www.openlims.ai/information)。默认监控关闭，不会因部署启动全量下载或模型任务。

## 源码与检查

- PM [PR #38](https://github.com/OpenLimsAI/mb-pm/pull/38) 全部检查通过后 squash：`1d228db1ed85b7d1a31d2a2c971628acfbd3e4c0`，保留同日 main 上已合并的知识方案应用。
- KB [PR #32](https://github.com/OpenDIKW/dikw-mbweb/pull/32) 与附件显示修复 [PR #33](https://github.com/OpenDIKW/dikw-mbweb/pull/33) 均在全部检查通过后 squash；最终固定：`0ef119729985eaf5e26da3121add1f3d3b033afc`。
- PM 合并后后端 403 项测试、原有账号/门户 90% 门槛（93.77%）通过；官方校验 Node20 下前端 127 项测试、覆盖率和构建通过。Node26 的新知识方案测试受实验 Web Storage 影响，未修改测试门槛绕过。
- KB 最终 404 项测试、39 项浏览器回归及原有覆盖率/包大小门槛通过。DOMPurify 锁文件升级 3.4.17，修复新公开的高危/严重审计阻断，审计标准不变。实际候选镜像用已验证 Trivy 0.70.0 和 2026-10-23 官方数据库检查，高危/严重可修复项 0。
- 官方 Q1A(R2) 与 Q1C 实际 PDF 经独立本机 PM worker → 签名 BFF → Core 0.6.10 完成归档、原件校验一致、真实索引与检索；只用本地 embeddinggemma:300m，云端模型请求 0。使用显式本机验收身份，不代替客户真实 IAM 浏览器验收。
- 深浅色真实数据界面及附件显示修复复核、控制台无异常；Lighthouse a11y1.00/1.00、CLS0.0181/0.0181，LCP1251/1257ms。见[本地证据和范围](../../../docs/verification/20261023-information-live.md)。

## 发布与数据

- 发布时间 UTC：`2026-10-23T18:35:32.032433+00:00`。
- PM 镜像：`mb-pm:information-live-20261023T181528Z`，ID `sha256:5ecaffadf885fa5a0a9fa96073d7cf7dcec7a4f693f743ffdfc8ce1184fc04b4`。
- KB 镜像：`dikw-mbweb:information-live-20261023T181528Z-pdf`，ID `sha256:afd5fb42b743523184768c9a3d8ea15cab9214f0f04129ec2675b95de795643d`。
- 同时更新两个 PM 实例及一个 MB 知识库 BFF；其他 10 个容器 ID 一致。
- 原有 13 张项目管理业务表内容校验一致；知识库 Core 目录、原件文件、文件夹、译文、标签及删除记录校验一致。没有恢复旧数据或启动生产模型验收任务。
- 新增 `information_entries`、`information_texts`、`information_leases` 与原文共享卷 `mb-pm-v2_information_originals`；知识库原数据卷新增 `information-imports.sqlite`。
- 新桥接密钥仅在客户服务器生成并以0600保存，不复制既有 Core 令牌；三个应用使用独立内部网络 `maibo-information-bridge`，无新公网端口。其他环境值和已有卷保持一致。
- 公开 HTTPS 验收 19 项通过：健康、固定入口、PM 产物哈希/版本更新、匿名接口及 KB 静态资源拒绝、无签名桥接拒绝和原 OAuth 回调/S256；服务器内另核对 KB 全部166项前后端产物与固定提交构建清单一致。服务器侧已以实时管理身份只读核对真实知识库文件夹连接，IP 应急入口检查通过。

## 备份与回滚

私有备份目录：`/home/prometheus/mb-pm-v2/private-config-backups/information-live-20261023T181528Z`。包含 PM/IAM/Core PostgreSQL 可读备份、知识库原件目录、在线 SQLite、AI 配置、原 Compose/env 和镜像回执；备份留在服务器。

回滚 PM 至 `mb-pm:information-20261023T040231Z`，KB 至 `dikw-mbweb:tag-catalog-20261022T154330Z`，并恢复此次备份的 Compose/env，仅重建这三个应用。保留新增表、原文卷和 SQLite，不能覆盖上线后的客户新数据；不执行全栈 down 或删除卷。脚本异常路径自动恢复原镜像/配置，生产切换本次实际结果以上述回执为准。

## 验收边界

客户本人登录后的批量收录、开启监控和知识问答仍待使用验收；没有借用客户浏览器身份或写入测试论文。扫描/加密 PDF 明确提示 OCR/解密前提。历史采集版本在 Core 独立保留，全库问答可能检索历史；可从具体版本进入单篇问答。提醒为应用内已读/关注口径，尚无邮件/短信推送。费用估算不是真实账单。详见[信息获取说明](../../../docs/information.md)。
