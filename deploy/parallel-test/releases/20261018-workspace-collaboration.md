# 门户与项目协作升级上线记录

2026-10-18 14:32（Asia/Singapore，UTC+8）完成生产切换。门户与项目管理已上线，IP 直连应急入口同步更新；客户账号的真实登录和业务操作待验收。

## 发布内容

- 门户「账号管理」集中维护 IAM 账号与组织成员；系统管理员可编辑，项目负责人只读，员工不显示管理入口。新增账号及重置密码后，在应用内修改临时密码。
- 品牌登录页直接输入 IAM 账号，沿用 IAM 单点登录；需要特殊验证时回退 IAM 原生登录。
- 工作台区分「工作应用」与「管理功能」，账号列表突出「登录账号」；个人设置改为「我的设置」。
- 「版本更新」移至门户导航及首页，原 PM `/release-notes` 兼容跳转；「AI设置」移回项目管理，沿用原模型、密钥和提示词。
- 项目预算、成本结构与项目结构合并在「编辑项目」内一次保存；取消时一并放弃，校验并发冲突。
- 任务只能派给项目团队成员；仍有任务的成员不能移出。移除 PM「相关系统」和固定 CTO 标签，突出返回应用工作台。

## 版本与备份

下述服务器相对路径均以 `/home/prometheus/mb-pm-v2` 为根。

| 项目 | 实际值 |
|---|---|
| 新镜像 | `mb-pm:workspace-20261018T062747Z` |
| 镜像 ID | `sha256:9db8183da74fca45598deb5aeed0b0572f13cb67c2c2a2ea9f0afdef3387edc5` |
| 回滚镜像 | `mb-pm:project-levels-20261015T083222Z` |
| Git 基线 | `feat/account-admin`，HEAD `acff84680c72256e66aa7a68761afccff9fb3de0`，包含已核对的未提交改动及新增文件；部署时尚未提交或推送 GitHub |
| 准确源码 | `releases/workspace-20261018T062747Z/`，232 个源文件及逐文件 SHA256 清单 `source-state.json`；仅 checkout HEAD 不能复现此次发布 |
| 源码包 SHA256 | `e7cc5ee365f1b2532b9e2291802c0b25f678e6d0e1e43e607dfce0abb491f037` |
| 构建方式 | 完整构建前端，替换 `/code/app` 与 `/code/static`；依赖文件与前一镜像一致，复用其 Python 依赖层，过程见源码目录内 `Dockerfile.application-update` |
| 备份目录 | `private-config-backups/workspace-20261018T062747Z/` |
| 备份内容 | PM / IAM 数据库、切换前最新 `pms-before-switch.dump`、`.env`、`app.conf`、三份 Compose、直连 Caddyfile、AI 设置、前一镜像及容器清单；私密文件仅留服务器 |
| 核验回执 | 同备份目录中的 `candidate-checks.json`、`data-before-switch.json`、`deployment-receipt.json`、`public-checks.json`、`cleanup-and-health.json` |
| 切换时间 | 2026-10-18T06:31:31Z 开始，06:31:58Z 完成，约 27 秒 |

只重建 `mb-pm-v2-app-1` 与 `mb-pm-v2-app-direct-1`。其余 11 个生产容器 ID 不变，包含 PM / IAM 数据库、Casdoor、Cloudflare Tunnel、直连代理及知识库服务。运行环境变量、Compose、`app.conf` 与 AI 设置核对不变；`.env` 仅修改 `PMS_IMAGE_TAG`。

## 数据变更与验证

新增 `iam_password_change_required` 临时密码标记表。既有账号不因升级被要求改密；本次验收不执行生产 IAM 写操作。

启动补齐一条「已有任务但未加入项目团队」的成员关系，`project_members` 从 2 条变为 3 条。其余八张业务表逐行归一化后 SHA256 一致：项目 2、子项目 7、任务 34、依赖 38、预算 2、基线 0、成员 5、IAM 绑定 5。候选库中的改名、预算保存等测试数据未写回生产。

| 范围 | 结果 |
|---|---|
| 本地 | 完整后端 243 项测试通过；前端构建、变更文件 ESLint、门户路由检查通过 |
| 生产库副本 | 47 项通过：数据保留、新表、团队补齐与幂等、匿名权限、登录发起配置、IAM 只读查询、预算与项目联合保存、冲突 / 非法输入回滚及前端内容 |
| 正式服务 | 两个应用均 healthy；`direct_entry.py check` 通过，未使用真实账号密码；启动后日志无 traceback、ERROR 或 500 |
| 公网 | 15 项通过：www 登录 / 帮助 / 版本页、PM 页面与健康、最新脚本、IAM 登录及跨域凭据响应、KB HTML 登录入口；匿名账号 / 项目 / AI 接口仍 401 |
| 浏览器 | 新版用户名 / 密码表单与 10 月 18 日更新说明已确认；旧 PM 版本页跳到门户，匿名状态进入 www 登录页 |

候选鉴权检查使用进程内模拟会话和依赖替换，真实 IAM 调用限制为只读；不等同于客户账号线上验收。生产浏览器未输入客户密码，也未修改客户业务数据。后续用客户账号确认工作台入口、账号权限、项目与预算统一保存及 PM / KB 单点登录。

探测说明：本机 Python urllib 请求得到 Cloudflare 403，而浏览器与 curl 正常；改用 curl 完成公网核验。KB 对匿名默认 API 请求返回 401，对 `Accept: text/html` 返回含 `/web/auth/login` 跳转的登录页 200，符合其现有行为。未为探测调整 Cloudflare 或应用安全配置。

临时候选应用、隔离 PostgreSQL 容器及其匿名卷、临时环境文件已清理，生产卷和备份保留。部署后补充的 Markdown 交接记录不改变已构建的源码清单；服务器另存 `releases/workspace-20261018T062747Z/DEPLOYMENT.md`。

## 回滚

在 `/home/prometheus/mb-pm-v2` 仅把 `.env` 的 `PMS_IMAGE_TAG` 改为 `project-levels-20261015T083222Z`，再执行：

```sh
docker compose -f compose.yml -f compose.production.yml up -d --no-deps app
docker compose -f compose.yml -f compose.production.yml -f compose.direct.yml up -d --no-deps app-direct
curl -fsS http://127.0.0.1:18082/health
python3 direct_entry.py check
```

不整份覆盖 `.env`，不回退数据库，不删除新增表或团队关系，不执行 `down -v`。旧版不提供门户账号管理，也不会执行新增的临时密码标记流程；若新版上线后已开通账号或重置密码，回滚前先核对这些账号的改密状态。数据库恢复仅用于经确认的数据损坏处置，不能作为普通镜像回滚步骤。
