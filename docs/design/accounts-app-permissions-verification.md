# 账号权限改造验证记录

日期：2026-10-18。状态：前后端代码已实现并完成本地验证，尚未部署。对应[改造方案与 TDD 记录](accounts-app-permissions.md)。

## 已实现的行为

- 系统管理员独立放在平台管理身份；PM 业务角色只包含员工、项目负责人，管理员显示继承的全部权限。
- 知识库只允许选择可编辑，仅阅读置灰；后端只接受 `kb_role=editor`，只读、旧身份字段及任意角色数组写入返回 422。
- 历史阅读者不自动升级，PM 历史角色保留；只改平台身份、KB 或公共资料不会自动创建 PM 成员。
- 列表分别显示平台身份、PM 和 KB；保存展示修改摘要，关闭或切换未保存的资料与权限草稿时可继续编辑或明确放弃。
- 账号管理写操作使用共享数据库锁，IAM 保存后回读；IAM 中途失败、本地查询或提交失败均尝试补偿本次变更，补偿结果也回读，失败明确报错。

## 验证结果

环境为 Windows、Node.js 24.15.0、Python 3.12.12；PostgreSQL 使用全新的独立 16 系列测试容器。自动测试使用本地测试签名和 Casdoor HTTP 替身，不访问生产 IAM。

| 检查 | 结果 |
|---|---|
| 前端组件及 HTTP 集成测试 | 39 项通过 |
| PostgreSQL 后端全量测试 | 282 项通过 |
| SQLite 账号管理接口回归 | 66 项通过 |
| 默认构建与启用 API 的生产构建 | TypeScript 检查及 Vite 编译通过 |
| 门户路由检查 | 域名分流、固定目标、深链接和不安全返回地址通过 |
| 前端变更文件 ESLint | 通过 |
| 后端格式检查 | `backend/app` 70 个文件通过 |
| 后端新权限逻辑 lint | `services/accounts.py`、`schemas/accounts.py` 通过 |
| 文档核对 | README 保留规定的 8 个二级章节、90 行；已核对现行说明和方案的相对文件链接 |

### 模块覆盖率

| 范围 | 行覆盖率 | 分支覆盖率 | 其他指标 |
|---|---|---|---|
| 前端账号权限相关模块 | 99.25% | 96.76% | 语句 98.53%，函数 98.37% |
| 后端账号权限及门户接口模块 | 94.89% | 90.32% | pytest-cov 行与分支综合指标 93.85% |

前端范围是 `src/components/accounts/`、`src/pages/PortalAccounts.tsx`、`src/lib/accountAdmin.ts`、`src/api/accounts.ts`；逐文件的语句、行、函数、分支均设置 90% 门槛。

后端范围是 `app.services.accounts`、`app.schemas.accounts`、`app.api.v1.accounts`、`app.api.v1.portal`；CI 使用分支测量和 `--cov-fail-under=90`。以上指标不是整个仓库的覆盖率。复现命令见[开发与测试说明](../development.md#构建与测试)。前后端门槛已写入 CI 配置，远端 GitHub Actions 尚未触发。

## 页面核对

使用实际 API 模式的构建产物和本地只读账号数据替身核对页面，示例人物均为虚构账号。

- [桌面编辑面板](accounts-app-permissions-implementation.png)：平台身份独立、PM 角色分区，KB 可编辑选中、仅阅读禁用。
- [390px 窄屏编辑面板](accounts-app-permissions-mobile.png)：角色选项改为单列，内容可滚动，标题、页签与操作栏保持可用。

## 后续验收与存量事项

真实 IAM 登录、PM / KB 重新登录采用新角色、跨应用 SSO 仍需部署后验证。门户入口缓存只影响目录显示，不改变已签发令牌；本次不承诺独立 KB 旧会话即时撤权。没有进行线上账号修改、服务器发布或数据库结构迁移。

本地全量测试中的 AI 文件模式断言已按平台处理：POSIX 环境仍严格检查 `0600`，Windows 不以 POSIX 模式位判断权限。运行依赖版本未改变；额外执行的生产依赖审计仍报告 axios、form-data、react-router、react-router-dom 的 4 项存量 high 告警，未在本功能中扩大修复范围。
