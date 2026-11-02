# 员工门户登录表单恢复 · 生产发布（2026-11-02）

2026-11-02 07:49:33（America/New_York，UTC-5）完成应用切换。以正确生产参数重建当前固定源码的前端，恢复被错误构建禁用的登录表单；后端和既有业务数据保留。原因及漏检链路见[调查记录](../../../docs/verification/2026-11-02-login-build-incident.md)。

## 固定版本

- 已合并且原提交五项 CI 成功的 main 固定源码：`1b2cbe5270f3d8b0d1b9759dac63d43639ace94b`。
- 纠正参数：`VITE_USE_API=true`、`VITE_API_URL=/api/v1`，应用模式继续按域名分流。
- 镜像：`mb-pm:login-build-fix-1b2cbe5-20261102`。
- 镜像 ID：`sha256:ce175a32c80898886a44d790839b26babb75a35d49e5746357f2686c4cee2383`。
- 前端归档 SHA-256：`253026fea8aeb84d23279f7c3385584511dfc11c2c5718968e4eb5fd9e9b2a18`。
- 正确入口脚本：`/assets/index-BwikCcEG.js`；源站入口 HTML SHA-256：`f15e0e0f9c550d1b8c70d382a61c96afc60b8090931d7bad3c654cff7c7992a7`。
- 切换前镜像：`mb-pm:assistant-answer-copy-1b2cbe5-20261102`，镜像 ID `sha256:f06fd7113d62d30907476484dbb7e49205a0044a55623de90f50aa54708c3f8f`，保留用于取证；其登录表单已知故障，不能当作“恢复可登录”的正常回滚目标。

本次当前源码未包含新 PR 的构建清单与永久防误发代码；那些防线的合并与后续部署另记，不将它们计入本镜像。

## 备份、候选与切换

服务器源码和验证目录：`/home/prometheus/mb-pm-v2/releases/login-build-fix-1b2cbe5-20261102`。受限备份目录：`private-config-backups/login-build-fix-1b2cbe5-20261102/`，包括切换前及最终切换前数据库 dump、运行环境、全部 Compose、容器状态、AI 配置和诊断日志；私密内容留在服务器。

继续使用实际七文件组合：

1. `compose.yml`
2. `compose.production.yml`
3. `compose.direct.yml`
4. `releases/header-9516977/compose.no-note-sync.yml`
5. `releases/assistant-dikw-e294fdc/compose.knowledge.private.yml`
6. `releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml`
7. `releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml`

基于切换前固定镜像仅替换静态文件，校验后端摘要完全一致；使用隔离数据库副本和最终镜像候选验证，不运行数据库迁移或重新灌种子。发布锁保护下仅修改两个应用服务镜像，分实例等待 healthy。

## 已完成验证

- 正确参数构建通过；本地完整前端 720 项与覆盖率门槛通过。
- 候选实际镜像经回环 SSH 浏览器检查：用户名/密码均启用，可填写测试文字，提交按钮可用；实际请求 `/api/v1/portal/me` 返回匿名 401，配置接口 200。没有提交密码或登录表单。
- 两个正式应用实例均 healthy，`/health=200`、匿名门户 `/me=401`、配置接口 200；两者各自通过现有真实知识连接读取 280 篇论文。
- 两个实例后端摘要均为 `cbe2303eb1088595160c09146ceb412c21c323e9b0d8e72e447d0d8c56e26bbb`，与修复前一致。
- 七份展开 Compose 仅镜像字段变化；38 张表业务 ID、助手完整消息内容摘要保持，另外 15 个生产容器未变；隔离候选副本不计入生产对比。
- 2026-11-02 07:52（America/New_York）公网 `/login=200`，引用新脚本 `index-BwikCcEG.js`；其 SHA-256 `0c8b4959a14f45e8d0195b77c4bb9c6b611c21318b6e5c6a2a0ba3386cbfb33e` 与本地产物相同，配置接口 200、匿名 /me 401。
- 公开匿名 Chrome 隐身窗口真实打开正式 HTTPS 登录页，两输入框可编辑并成功填写测试文字，提交按钮可用；没有提交。IAB 自动化通道超时单独记录，没有据此误判网站仍故障。

尚未用客户真实凭据提交登录，真实账号、授权回调和跨应用 SSO 不计为本次已验收项。

## 回退边界

不回退或清理数据库、卷、账号与密钥。若新镜像出现其他异常，先保存诊断和最新备份，固定当前镜像/配置核对，再选择经验证的已知可登录候选。切换前镜像本身含登录故障，仅恢复它会重现禁用表单；不要把自动回到切换前状态的技术路径误写为业务登录已恢复。更早 `knowledge-select-category-20261102` 是当时已知可编辑表单版本，但是否适合作为当前回退需另核对后端与新增业务兼容性。
