# 新功能说明与 Release notes

系统入口：门户工作台顶部导航或首页「版本更新」→ `/release-notes`（沿用门户登录守卫，不要求项目管理权限）。项目管理旧页面 `pm.openlims.ai/release-notes` 自动跳转到门户 `www.openlims.ai/release-notes`。
独立 HTML：`public/release-notes.html`，可直接在浏览器中打开、下载或打印；部署后访问 `/release-notes.html`。
独立文件只含通用产品说明，可公开阅读，不含客户数据、账号、密钥或内部部署信息。

## 每次升级怎么更新

1. 编辑唯一内容源 `docs/releases/notes.json`，在 `releases` 数组开头追加一条记录，保留之前的记录。
2. 填写唯一英文 `id`、实际变更日期 `date`、已有版本名称 `version`、标题、摘要与 `changes`。有正式版本号时使用真实版本号，尚未编号时使用功能名称；不要把开发记录写成已上线。
3. 更新 `features`、`comparison`、`roles`、`boundaries` 中发生变化的说明；特别注意权限、入口、配置前提及尚未完成的功能。
4. 执行 `npm run release-notes` 生成 HTML；`npm run dev`、`npm run build` 也会自动生成。不要直接修改生成的 HTML。
5. 在浏览器核对桌面和窄屏、章节锚点、历史记录折叠以及下载，执行 `npm run build`，把 JSON、样式/生成器的必要修改及生成的 HTML 一起提交。

追加记录示例（替换占位内容和日期）：

```json
{
  "id": "release-yyyymmdd-topic",
  "date": "YYYY-MM-DD",
  "version": "实际版本号或功能名称",
  "title": "一句话说明本次变化",
  "summary": "对用户有什么影响，以及是否需要配置。",
  "changes": [
    { "type": "新增", "items": ["功能、入口和适用角色。"] },
    { "type": "修复", "items": ["什么情况下出错，现在如何处理。"] }
  ]
}
```

## 本次对照依据（2026-09-28）

- 旧版参考基线：`97954eb`（2026-06-27）及客户旧版 `mb-pm-app` 的只读运行产物核对。服务器未保留源码 Git 信息，因此不声称运行镜像精确等于该提交。
- 旧版 JS `index-Cb5pRcc1.js` 校验值：`b4fa2b10b4400aa94696c0600b2c56d75927bdbf02a6c4140a83668143c98211`。已核对其包含财务总览、组织总览与花费列，不包含我的看板、延迟推演、AI 分析及独立甘特/负荷/设置路由；旧容器 API 目录不含 AI 服务。
- 新版功能基线：`ca524d5`，结合 `README.md`、`src/App.tsx`、`src/lib/permissions.ts`、各页面组件与后端 API 核对。
- 历史日期与功能：`aee7392`（初始）、`58c059e`（改派及团队守卫）、`c7a26e0`（任务预算与财务）、`45013b0`（长 ID 导入修复）、`e80c83c`（实际花费）、`9fed582`（首页总览）、`df557b8`（IAM 接入）、`ca524d5`（IAM 协作版）。6 月 27 日的多次变化按日期归并。
- 本地旧版目录另有未提交开发改动，因此不能直接把两个目录差异当作客户已上线功能差异。
- HTML 中不记载客户数据迁移、账号开通或路由发布为已完成；这些属于环境部署状态，不属于代码功能发布记录。

样式源为 `docs/releases/style.css`，生成器为 `scripts/build-release-notes.mjs`。生成文件无需 JavaScript、CDN、字体下载或 API 即可阅读；折叠和锚点采用浏览器原生 HTML。
