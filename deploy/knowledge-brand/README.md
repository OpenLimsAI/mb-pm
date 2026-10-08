# 迈博知识库界面统一

2026-10-08 已部署至 [kb.openlims.ai](https://kb.openlims.ai/)。[上线与 SSO 核对记录](../parallel-test/releases/20261008-knowledge-brand.md) 保存准确镜像、备份及验收范围。

## 源码与修改范围

- 实际应用源码是私有仓库 [OpenDIKW/dikw-mbweb](https://github.com/OpenDIKW/dikw-mbweb)，不是本仓库的 PM 前端，也不是管理工作台 `dikw-web`。
- 本次基于 `v0.1.10` / `05a2568fee7db8be7776f5c511a19a6af2fcbf7f`。本地工作目录为 `/Users/bruce/Documents/00_Projects/1.MBERP/integrations/dikw-mbweb-customer`。
- `maibo.patch` 是针对该基线的源码补丁，包含企业 Logo。主要改动：`src/App.tsx`、`src/styles/maibo.css`、响应式断点、页面标题；未改后端、依赖版本、IAM 或业务权限。
- 对齐 PM 的 RGB(35,72,111) 顶栏、白色侧栏、灰色背景、青色按钮和浅色卡片，保留论文阅读 / 问答 / 笔记及深色模式。

拥有私有仓库权限的维护者可在独立目录恢复源码：

```sh
git clone https://github.com/OpenDIKW/dikw-mbweb.git dikw-mbweb-customer
cd dikw-mbweb-customer
git switch -c feat/maibo-brand v0.1.10
# 将下面路径替换成当前 mb-pm 仓库的绝对路径
git apply --check /path/to/mb-pm/deploy/knowledge-brand/maibo.patch
git apply /path/to/mb-pm/deploy/knowledge-brand/maibo.patch
# Node >=24，按 lockfile 安装；真实配置不进入 VITE 变量
npm ci
npm run lint
npm test
npm run build
npm run format:check
npm run check:bundle
npm run check:gate
```

`check:gate` 需要完整 Git 历史中的 `origin/main`；浅克隆应先补全历史。本次通过 33 个测试文件、203 项测试；未执行完整覆盖率及端到端测试命令。

## 已发布包与部署边界

准确发布包保留在服务器 `/home/prometheus/dikw/brand-releases/maibo-20261008T004840Z/`，含源码 / `dist`、SHA-256 清单、发布脚本及候选 / 上线检查结果。其 `manifest.json` 对应实际部署包；不能拿新构建产物覆盖同名快照。

`publish.py` 在服务器执行两个阶段：`prepare <tag>` 验证隔离候选，`switch <tag>` 再切换。只派生已有 `dikw-mbweb:0.1.10` 镜像、替换 `/app/dist`，保持原 BFF 文件、配置、会话卷、IAM CA 和 Core 数据。切换前核对当前容器及配置没有并发变更；失败自动回退。

该脚本和本次清单是**一次发布的保护规则**，显式限制源镜像为 0.1.10；不能直接用于后续版本或再次运行本次 `switch`。后续发布应重新核对线上基线、生成新标签与清单、备份及独立候选，再修改 `MBWEB_VERSION`，仅重建 `dikw-mbweb`。不要执行 `down -v`、替换整个 `.env`，或修改 PM / IAM 的镜像。

真实配置备份只留在服务器 `brand-backups/`；不将 `.env`、容器完整环境、客户端密钥或数据库复制进仓库。具体回滚和验收见上线记录。
