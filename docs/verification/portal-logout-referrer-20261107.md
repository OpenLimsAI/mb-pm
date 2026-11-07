# 门户退出来源校验修复：本地验证

- 基线：`2bd39089a0d70c5a9c36e9c5afb269be93f3e491`，独立分支 `fix/portal-logout-referrer-20261107`。
- 仅 SPA index 入口响应使用 `same-origin`；必须服务端标记、200、HTML；API 强制 `no-referrer`。Origin 精确比较未修改。
- 后端隔离测试：`pytest tests/test_spa_referrer_policy.py tests/test_spa_cache.py tests/test_portal.py tests/v4_contract -q`，113 passed。
- 补充：`pytest tests/test_session_renewal.py tests/test_data_backup_spa.py -q`，37 passed、1 skipped；跳过项需要 PostgreSQL 跨实例行锁，当前临时 SQLite 不覆盖。
- `ruff check app/main.py tests/test_spa_referrer_policy.py` 通过；`ruff format --check app` 177 文件通过；`compileall app/main.py`、`git diff --check` 通过。
- 测试复用本地 `cmc-pm-e074-tests:local`，无网络，临时 SQLite 与测试密钥；存在 Starlette TestClient 弃用提示及未安装 pytest-asyncio 的配置警告，不影响上述同步用例。
- 真实 ThinkPad Chrome 独立 profile、本地后端、最小 SPA 原生 form：旧策略覆盖时 Origin:null、403、测试 session 保留；修复后正确 Origin、303、测试 session 删除。null/错误端口仍拒绝；API、独立认证 HTML、认证回调仍 no-referrer。
- 浏览器证据在本机 `.local-runtime/logout-browser-qa-20261107/REPORT.md` 与 before/after-result.json（位于 cmc-platform 工作目录下，不随本提交纳入）。该验收使用假 IAM 落点，不是完整 React/真实 OIDC 端到端。
- 没有前端源码变化，未重复 TypeScript 检查或完整前端构建；未运行完整 PostgreSQL CI。首次尝试的运行镜像无 pytest，后改用测试镜像；一次补充命令引用不存在 test_auth.py，未运行测试，已改为上述实际存在的会话回归。
- 仅本地修复及验证，未推送、未创建 PR、未部署生产。

规范依据：https://fetch.spec.whatwg.org/#append-a-request-origin-header 。原生 form 导航不是 CORS 模式，no-referrer 可令 POST Origin 为 null；不得通过接受 null 或删除 CSRF 校验来规避。
