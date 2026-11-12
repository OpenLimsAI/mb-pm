# 迈博 Blue Edition 设计稿

本目录保存统一蓝色视觉方案的源文件、离线交付页与两张原始预览图。正式应用的实现位于各应用源码；这里的账号、指标、任务、论文和模型回复均为合成示例。

- [离线交互设计稿](index.html)：15 个可切换页面。
- [使用说明](使用说明.txt)：可操作范围与设计稿边界。
- [工作台预览](workspace-preview.jpg)、[论文知识库预览](knowledge-preview.jpg)：设计稿原始截图。

主色为 `#1E466B`，强调色为 `#67BAF4`，柔白为 `#FAFAFA`，主要文字为 `#0D0D0D`。成功、警告和错误保留各自语义颜色。

## 维护与生成

源文件为 `shell.html`、`styles.css`、`core.js` 和 `extra-views.js`。修改后执行：

```sh
python3 docs/design/blue-edition/build.py
```

`build.py` 会在同目录重新生成单个 `index.html`，不访问网络或业务服务。生成页包含全部样式和交互，可直接离线打开；维护时修改源文件，不手工修改生成页。

如需在已有本地工作台中预览，可将生成页复制到被 Git 忽略的 `dist/blue-design.html`，再访问 `http://localhost:1234/blue-design.html`。该预览副本会随前端重建被移除，不应强行加入运行源码提交。

设计稿中的演示交互不会执行真实登录、AI 调用、上传、保存或删除。页面输入内容仅用于当前预览，不会写入真实系统。
