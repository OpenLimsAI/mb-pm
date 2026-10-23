# 信息获取交互首版 · 生产上线记录

2026-10-23 00:09（America/New_York，UTC−4）完成切换。门户「工作应用」新增「信息获取」，正式入口为 `https://www.openlims.ai/information`。
用户已确认首版范围为可操作界面，真实采集后续实现；生产界面保留演示标识，不将演示进度、资料、文件夹或费用作为实际完成记录。

## 交付与版本

| 项目 | 实际值 |
|---|---|
| 功能 PR | [#35](https://github.com/OpenLimsAI/mb-pm/pull/35)，最新 5 项 CI 全部通过后 squash merge |
| 固定构建源码 | `main` 提交 `571aacda873a395a8d6b77ee90c640d71847217f` |
| PR CI / main CI | [39897527780](https://github.com/OpenLimsAI/mb-pm/actions/runs/39897527780) / [39897695917](https://github.com/OpenLimsAI/mb-pm/actions/runs/39897695917)，均成功 |
| 生产镜像 | `mb-pm:information-20261023T040231Z`（标签使用 UTC） |
| 镜像 ID | `sha256:d12e6f3975dfe979724169e800bf66efc7e79dec751f51f9677e5590e0a2cc17` |
| 回滚镜像 | `mb-pm:task-progress-20261022T070839Z`；ID `sha256:46696d655cc243baba2821414835a0cc0c0ad1b7b7e2c2e8621387b632e26952` |
| 源码快照 | `/home/prometheus/mb-pm-v2/releases/information-20261023T040231Z/`，250 个已跟踪构建文件及 `source-state.json` |
| 发布包 SHA256 | `ff62f2394d5a38d52a57b49d91177fa3147706ad49b05dc691b7c2234f626784` |
| 切换检查窗口 | 2026-10-23T04:09:09.368587Z 至 04:09:35.841286Z，约 26.47 秒；不是逐请求测得的停机时间 |

## 行为与变更范围

- 七个界面：工作台、情报收件箱、批量收录、知识资料、信息源、我的关注、运行与费用。筛选、范围配置、暂停重试、版本对照、解析与测算均为浏览器演示。
- 复用门户已验证的实际身份及强制改密守卫；信息获取面向有效组织成员，不要求先有 PM / KB 角色，不创建 PM 成员或授予知识库权限。
- 浏览器状态按已验证 IAM issuer、组织和 subject 的 SHA-256 隔离；无隔离键或开发预览仅使用内存。刷新将运行中的模拟任务恢复为暂停，退出界面清理计时器。
- 没有采集、监控调度、下载、真实知识库入库、站外通知或模型接口；本次部署及验收未发送模型请求，未复制 Core 令牌。
- 从固定 main 提交导出构建输入，逐文件核对哈希；不含私钥、环境文件、数据库或未跟踪文件。
- 相比前一运行版本，后端 69 个文件一致，仅 `api/v1/portal.py`、`schemas/portal.py` 两处预期变化，运行依赖完全一致。沿用已核验的原本地镜像及相同前端构建步骤，完整替换 `/code/app` 和 `/code/static`；无数据库迁移。
- 仅重建 `app` / `app-direct`；其余 11 个容器 ID 未变，包括知识库、IAM、数据库及隧道。知识库继续运行 `dikw-mbweb:tag-catalog-20261022T154330Z`。
- `.env` 仅更改 `PMS_IMAGE_TAG`；其他配置、环境变量、挂载、网络和 AI 设置校验一致，保留 `AUTO_SEED=false`。

构建时首次使用 daemon 镜像 ID 作为 `FROM`，被 Docker 解释为仓库地址而失败；之后改用核验 ID 完全一致的现有本地标签完成构建。未更改镜像仓库、安全设置或应用源码。

## 备份与验证

服务器备份目录：`/home/prometheus/mb-pm-v2/private-config-backups/information-20261023T040231Z/`，目录权限 700，私密文件权限 600。数据库、配置及凭据仅留在客户服务器。

- 切换前 PM / IAM dump 均通过 `pg_restore -l`；保留原 `.env`、Compose、`app.conf`、直连 Caddyfile、AI 设置及前一镜像。
- `prepare.json`、`candidate-checks.json`、`deployment-receipt.json`、`runtime-checks.json`、`public-checks.json` 保存准备、隔离验证、切换、运行和公网检查结果。
- `data-before-switch.json` / `data-after-switch.json` 保存 13 张业务表行数和归一化哈希，不含原始记录。
- 发布源码目录保留构建输入和验证脚本；`information-20261023T040231Z.main-ci.json` 留存 main CI 成功回执。

| 范围 | 已验证结果 |
|---|---|
| 本地及 CI | 前端 106 项、后端本地 SQLite 300 项通过；账号覆盖率门槛保留；PR / main CI 成功，含 PostgreSQL 测试及镜像构建。详见[本地验证](../../../docs/design/information-interactive-verification.md) |
| 隔离候选 | 无网络、无生产凭据的临时容器通过 9 项检查：健康、SPA、匿名拒绝、无采集接口、有效身份与新入口、稳定身份隔离、异组织 / 禁用拒绝、不创建 PM 账号 / 业务会话、身份接口不缓存 |
| 正式服务 | 两个应用均 healthy，启动错误指标为 0，直连检查通过；AI 设置哈希与切换前一致 |
| 数据保留 | 13 张业务表切换前后行数及哈希一致；其他 11 个容器未变；未修改 IAM 角色 |
| 公网 | 本机经正常公共 DNS / TLS 完成 17 项检查，全部通过：PM 健康、门户 / 应用 / 任务页面、匿名鉴权、无采集 / 入库端点、IAM / KB 入口及新版资源哈希。页面 `no-cache`，带哈希资源长期缓存 |
| 知识库 | 容器和健康入口正常；匿名根请求返回 401；未做知识库业务写入 |
| 生产浏览器 | 打开新应用后重定向至品牌登录页；浏览器自动化读取超时，未取得登录后界面截图，未建立客户登录会话 |

正式静态资源核对结果：

| 路径 | SHA256 |
|---|---|
| `/assets/index-BrGTUVEu.js` | `8646ce958d85f81b3fadada3d66729627aaa1dd2341e1dc50bad163fcdec5d49` |
| `/assets/Information-DBo8SCvQ.js` | `054f2d164b7a3f02c1ca5aea7691323a2d4e8b939df2fbd7a91708ed3b33ff05` |
| `/assets/Information-CxyggIbG.css` | `fb408f5473fe4ce354be568396def119e2578b5033bdd89f5a364f024f7252c9` |

**真实账号验收待完成：** 客户登录工作台后进入信息获取，核对实际姓名、演示提示、七个页面及返回工作台；按需要体验浏览器内的演示交互。真实 ICH 抓取、知识库文件夹联动、后台运行和实际模型用量均未实现，不属于此次已验收内容。

## 回滚

在 `/home/prometheus/mb-pm-v2` 仅将 `.env` 的 `PMS_IMAGE_TAG` 改回 `task-progress-20261022T070839Z`，执行：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
curl -fsS http://127.0.0.1:18082/health
python3 direct_entry.py check
```

切换脚本在健康、配置或数据核对失败时恢复原镜像；本次未触发回滚。不回退数据库、不整份覆盖 `.env`，保留原镜像与备份。回滚后信息获取入口消失，浏览器中的演示状态不构成业务数据。

本记录及交接文档经独立文档 PR、CI 和 squash merge 归档，不触发额外生产部署；运行源码仍固定为上述功能合并提交。
