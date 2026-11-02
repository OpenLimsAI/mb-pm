# 登录表单无法输入 · 构建与发布根因（2026-11-02）

本调查以 America/New_York（EST，UTC-5）记时，核对公开静态脚本、保留的逐版产物、构建命令及服务器回执，不包含密码或会话数据。

## 发生了什么

2026-11-02 03:12 的 `assistant-answer-copy-1b2cbe5-20261102` 发布首次引入该故障。前一线上 `knowledge-select-category-20261102` 的登录脚本为正常启用条件；本次 `index-CaSxpRKl.js` 则把输入框条件编译为 `de=u||ce||!0`，两框均使用 `disabled:de`，提交按钮也为 `disabled:N||!0`。`!0` 是 true，因此表单恒禁用。

源站与公网故障脚本 SHA-256 均为 `07ae48b5cac1b0d3af9b3b80d039e300d3eb2c80b829c147c0882334c8f91650`。真实 API 初始化也被优化移除，账号密码尚未进入验证流程；同期门户/IAM 接口与容器健康检查均正常。

## 因果链

1. `src/api/client.ts` 仅在 `VITE_USE_API === 'true'` 时启用 API；Vite 在打包时内联该值。压缩构建的 production 模式不等于打开业务 API。
2. 最终发布目录执行了普通 `npm run build`，命令遗漏 `VITE_USE_API=true` 和 `VITE_API_URL=/api/v1`。该目录的 `.env`、`.env.local`、`.env.production`、`.env.production.local` 均不存在。未保存当时完整 shell 环境，故不虚构变量究竟未设还是继承为 false；产物直接证明没有启用 true。
3. 上传的是这次独立生成的 `dist.tar.gz`。`Dockerfile.release` 从前一镜像继承后直接 `COPY dist /code/static`，绕过了标准 Dockerfile 中显式启用真实 API 的 frontend 阶段。
4. CI 的普通 Vite 构建与单独 Docker 构建均成功，但并没有证明后来额外上传的 dist 是合格的生产产物。
5. 候选验收只覆盖健康、匿名 API、助手专项功能、路由和数据保留，没有验证匿名登录框可编辑。原回执明确 `authenticated_browser_checked: false`，健康 200 不覆盖这条交互路径。

故障不是前一版本遗留；逐版比对中，前一镜像的 `index-BAtZqfpf.js`（SHA-256 `dd65cbdc1412ab995182cbd01d9473995398eeed013d196bda57c0091c2df9e6`）没有固定禁用条件。

## 恢复与防线分开记录

[线上恢复记录](../../deploy/parallel-test/releases/20261102-login-build-fix.md)使用已合并固定源码 `1b2cbe5`，只纠正前端构建参数；没有借机发布新业务代码或改变数据库。

本 PR 增加[生产构建防线](../production-build.md)：显式生产入口、实际环境与全产物摘要清单、预构建镜像的失败即拒绝验证，以及真实编译包的匿名 Chrome 表单检查。普通本地预览继续允许关闭 API。防线代码合并本身不代表它已随当前热修复部署；当前修复镜像和后续防线版本分别保留源码与回执。
