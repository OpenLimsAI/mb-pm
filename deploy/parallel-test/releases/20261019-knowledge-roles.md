# 项目 AI 权限与知识库角色上线记录

2026-10-19 07:27:52 至 07:28:55（Asia/Singapore，UTC+8）完成生产切换。
此为切换和检查窗口，不是逐请求测量的停机时间。发布标识为 `roles-20261018T231318Z`。

## 已合并源码与镜像

| 组件 | 构建来源 | 正式镜像 / 配置 |
|---|---|---|
| 门户 / PM | `OpenLimsAI/mb-pm` main `7766c3a0e5a9f6905a93592e83d12e83815dd136`，含 [#25](https://github.com/OpenLimsAI/mb-pm/pull/25)、[#26](https://github.com/OpenLimsAI/mb-pm/pull/26) | `mb-pm:roles-20261018T231318Z`，同时更新 `app` 与 `app-direct` |
| 论文知识库 | `OpenDIKW/dikw-mbweb` main `50fdd98a378863366c3e8432314cd58dc25c77f8`，含 [#21](https://github.com/OpenDIKW/dikw-mbweb/pull/21)、[#22](https://github.com/OpenDIKW/dikw-mbweb/pull/22) | `dikw-mbweb:roles-20261018T231318Z` |
| IAM 代理规则 | PM main `db89665058a6da752b5fc3af66ee804fa67e01ec`，[#27](https://github.com/OpenLimsAI/mb-pm/pull/27) | `iam-proxy/Caddyfile` SHA256 `caa10396daf866b52aa95087e46edb859eb99678405da40f70c0c038e1fbb39d` |

以上 PR 均在全部 CI 成功后 squash merge。PM [构建源码 main CI](https://github.com/OpenLimsAI/mb-pm/actions/runs/39139849037)、[代理 PR CI](https://github.com/OpenLimsAI/mb-pm/actions/runs/39176191788) 与 KB [main CI](https://github.com/OpenDIKW/dikw-mbweb/actions/runs/39141830032) 均成功。`db89665` 相对 `7766c3a` 仅修改代理配置与说明，不改变 PM 应用构建输入。部署后的文档提交不重新发布应用。

- PM 镜像 ID：`sha256:a509fa9376d989b89f4e82d08bc208292ddb4030c5fb2afd9b5fa676d28b23ad`。
- KB 镜像 ID：`sha256:d86537acf6148f46c626912d0760eb7e5f6d7429bcfbb963591ec58ecd67849d`。
- PM 源码包 SHA256：`3970c472ca32b8f0f946c35c0dcbaaf919a0d734e94292cd9ada44dc2f0d10fc`；KB：`1936ccf600021c85b1edb4d22083485bbdadcdf8c6790a18cb8162f29f810ac0`。
- 前端 `/assets/index-D5X7JiEG.js` 的公网与容器 SHA256 均为 `22a37be10ef8370ad4a492eef8fbe7b11af0ccaaa8728f0afdc278d8c5bafff9`。

## 行为与配置

平台系统管理员排在普通成员前；项目负责人排在项目成员前。系统管理员保留全部 PM 权限；项目负责人可设置和使用 PM AI，项目成员不能查看或直接调用 AI。旧项目负责人继续受项目范围约束。

KB 移除「相关系统」，顶部以金色突出「应用工作台」。`kb_manager` 是知识库负责人，可上传论文、配置 AI；`kb_editor` 是知识库用户，可阅读、编辑、翻译与问答。历史 `kb_viewer` 继续只读；平台管理员和中台管理员不自动成为 KB 负责人。

在 `mabpharm` 新建启用的空 `kb_manager`，没有给现有账号新增权限。现有角色成员保持不变，负责人仍需系统管理员明确指定，首次改权后重新进入 KB。生产未导入本地空知识库、未更改用户密码。

代理仅新增严格匹配的 `GET /api/get-user?owner=mabpharm&userId=<已验证 subject>`，要求 Basic 请求头，Casdoor 继续验证应用凭据。其他组织、选择器、重复参数、附加参数、写接口和管理 UI 仍拒绝。代理的 admin API 关闭，因此通过 Compose 仅重建 `iam-proxy`，没有使用不可用的 reload API。

只重建上述四个容器；其余九个生产容器 ID 不变。保留 OIDC、SSO、Core ID、凭据、数据卷及 AI 环境配置。`.env` 仅更新 PM / KB 镜像标签；DNS、隧道、防火墙、Core、中台、数据库及直连代理未改。

## 构建、备份与验证

服务器从固定 main 源码构建。PM 的 Python 依赖清单与前一镜像 SHA256 相同，复用其依赖层，完整替换应用源码与新构建前端。KB 使用完整 Docker 构建。Docker 构建派生文件只移除镜像源故障涉及的 `syntax` 注释。未发布 GHCR 私有镜像：当前 GitHub 凭据没有 `read:packages`，没有降低仓库可见性或向服务器复制 GitHub 凭据。

私密备份目录 `/home/prometheus/mb-pm-v2/private-config-backups/roles-20261018T231318Z/`（目录 700、私密文件 600），保留 PM / IAM dump、Core dump 与原文件、KB 运行卷及在线 SQLite 备份、配置和代理 CA。Core 的实际库为 **`dikw_v06`**，有效备份为 `core-dikw-v06.dump`（30,127,246 字节），已通过 `pg_restore -l`；早先名为 `core.dump` 的旧空 `dikw` 库备份不能代替它。源码快照分别在 PM / DIKW 的 `releases/roles-20261018T231318Z/`，含逐文件 `source-state.json`。

| 核对范围 | 结果 |
|---|---|
| PM 候选 | 生产数据库副本上 23 项通过：管理员 / 负责人可用、成员拒绝、旧角色范围约束、实时降权等；测试会话是候选进程夹具 |
| 代理 | 候选与正式代理各 11 项通过；真实 TLS、真实 Casdoor 应用凭据的精确 subject 查询成功，九种越界请求拒绝 |
| KB 候选 | 8 项匿名 / OIDC 检查及 8 项候选会话检查通过；真实 IAM 用户名称匹配，普通用户不能上传或设 AI；只读访问现有 Core 的 1696 条内容记录 |
| 实际候选镜像扫描 | 官方 Trivy v0.70.0，按 CI 相同 `HIGH,CRITICAL`、`ignore-unfixed` 规则扫描 KB 新镜像通过；不代表所有未修复漏洞为零 |
| 正式服务 | PM 域名与直连实例、KB、代理均 healthy；直连登录链检查通过；部署后的启动日志无 Python traceback / panic |
| 公网 | www、pm、iam、kb 共 18 项通过；入口正常、匿名接口 401、KB 综合分析 403；新前端文件摘要匹配 |
| 数据保留 | 九张 PM 业务表逐行归一化 SHA256 一致；两条已保存中文记录及其摘要一致；没有恢复或重置数据库 |

详细机器回执：`deployment-receipt.json`、`pm-candidate-checks.json`、`kb-candidate-checks.json`、`kb-candidate-session-checks.json`、`proxy-acceptance-production.json`、`kb-trivy.json`、`public-checks.json`、`final-health-and-cleanup.json`。临时候选四个容器及其独立网络在验收后清理，生产卷、备份和旧镜像保留。

浏览器确认门户品牌登录页与 KB 的真实 IAM 授权入口可用。此次没有输入客户密码或创建生产会话，未代客户保存模型配置或消耗模型额度。负责人 / 用户真实登录、上传与索引、模型保存重启、翻译 / 问答、撤权，以及真实登录后的移动端、深色、可访问性和性能仍待验收。候选合成会话与匿名检查不能代替这些步骤。

## 回滚

仅把 PM `.env` 的 `PMS_IMAGE_TAG` 恢复为 `account-permissions-20261018T092058Z`，KB `.env` 的 `MBWEB_VERSION` 恢复为 `translation-20261008T012722Z`，分别用原 Compose 仅重建 `app`、`app-direct`、`dikw-mbweb`。PM 域名实例必须同时使用 `compose.yml` 和 `compose.production.yml`，直连再加 `compose.direct.yml`。

如需回滚代理，将上述备份中的 `proxy/Caddyfile` 恢复到原挂载路径，再仅重建 `iam-proxy`。保留 CA 和命名卷，不整份覆盖 `.env`，不执行 `down -v`，不回退数据库或删除 IAM 角色。旧 KB 会恢复原有编辑用户上传行为，也不读取新 `ai-settings.json`，应先评估权限影响。重新检查四个入口、数据、SSO 及健康状态。自动失败回滚分支已审阅，本次没有触发，也没有故意制造生产故障演练。
