# 受限 IAM 兼容契约

PM 与门户的本人策略要求 issuer/subject 与已认证身份一致，固定字段包含本人 id、owner、isForbidden/isDeleted、needUpdatePassword、lastChangePasswordTime，以及本人角色的 owner/name/isEnabled。缺字段或类型错误时不退回猜测角色。MDM 委托资源绑定由配套 IdP 精确配置，不能因此开放读组织或任意用户。

配套 mb-casd 维护 v4.25.0 + v11 scoped-policy 补丁，三个退出客户端和两个本人策略客户端须逐项配置；默认全空／关闭。该能力与旧 `casdoor_v4_userinfo` 模式不是同一种权限，禁止自动升级 DCR 类别。

本地先构建锁定依赖工具环境，在新空 PostgreSQL 测试库设置 `TEST_DATABASE_URL` 后，从 backend 运行：

```bash
python -m pytest tests/test_mdm_phase2.py tests/test_mdm_integration.py tests/test_oidc_status.py tests/test_portal.py tests/test_portal_settings.py tests/test_session_renewal.py tests/test_iam.py tests/test_iam_session_migration.py tests/v4_contract -q
```

必须保留完整仓库目录，迁移测试会读取 deploy/parallel-test；不能只复制 backend。测试自备合成数据与签名密钥，不访问真实 IAM；这些 API/单元测试不能替代正常浏览器密码登录和跨应用项目验收。

前端沿用 `npm ci`、`npm run test:coverage`、`node scripts/test-portal-routing.mjs`、`npm run test:production-build`、`npm run build:production` 和 `npm run test:production-login`。本地候选未提交时的构建不是固定发布版本。

本轮结果与未覆盖项见[候选验证](verification/pr-candidate-20261105.md)。正式启用须另行确认 IAM 配置、共享维护、备份及回滚；代码合入不等于部署。
