# 2026-10-08 · 知识库界面统一与 SSO 配置核对

日期采用 Asia/Taipei。知识库样式已上线；本次没有修改 IAM 配置或重建 PM。

## 单点登录实际变更

核对线上 IAM 数据和 `20261007T232541Z-sso-session` 修改前后备份，4 个应用的配置仅有以下 3 项不同：

| 配置 | 修改前 | 修改后 | 作用 |
|---|---|---|---|
| `enableSigninSession` | false | true | 登录后保留 IAM 会话，供其他应用识别 |
| `enableAutoSignin` | false | true | 识别已有 IAM 会话后自动完成新应用授权 |
| `cookieExpireInHours` | 0 | 168 | 显式设置记住登录的 Cookie 时限为 7 天 |

应用为 `admin/maibo-portal`（门户）、`admin/mp-pm`（项目管理）、`admin/dikw-kb`（论文知识库）、`admin/dikw-web`（管理工作台）。Casdoor 中 0 表示使用默认值，不能直接解释为“立即过期”；此前不保留会话才是跨应用重复输入密码的原因。

这次 SSO 改动只有 IAM 应用配置，没有新增账号、角色、共享业务 Cookie 或重建 PM。各应用仍使用独立客户端和会话，IAM 为新应用重新签发令牌；其 `expireInHours` 仍为 1 小时，不能将 7 天 Cookie 时限当作令牌有效期。门户退出不会自动清除其他应用已经建立的业务会话。

历史测试已用 `hele.hl` 完成 KB → 门户 / PM / IAM 免重复密码；本次客户也报告跨应用登录可用。本次代理仅只读核对配置，没有重新使用客户账号验收。依据：[IAM PR #12 / ADR-0004](https://github.com/OpenLimsAI/mb-casd/pull/12)。修改前后备份在服务器 `/home/prometheus/mb-pm-v2/private-config-backups/20261007T232541Z-sso-session/`，不将其含密钥的完整 JSON 复制进仓库。

## 知识库发布内容

- 对齐项目管理的企业 Logo、精确 RGB(35,72,111) 深蓝顶栏、白色侧栏、灰色工作区、青色按钮、边框及卡片。
- 侧栏提供论文研究、我的笔记、项目管理和应用工作台；固定链接分别指向 `https://pm.openlims.ai/dashboard` 和 `https://www.openlims.ai/`。
- 保留论文阅读、科学公式 / Markdown、问答、笔记、原有主题切换及退出流程；适配手机和窄屏。
- 只替换论文知识库前端 `dist`；后端、环境变量值、挂载及其余 10 个运行容器均未改变。管理工作台 `dikw-web` 的样式不在本次修改范围内。

| 发布信息 | 值 |
|---|---|
| 正式入口 | `https://kb.openlims.ai/` |
| 修改服务 | `/home/prometheus/dikw/docker-compose.yml` 中的 `dikw-mbweb` |
| 源码仓库 / 基线 | 私有 `OpenDIKW/dikw-mbweb`；`v0.1.10` / `05a2568fee7db8be7776f5c511a19a6af2fcbf7f` |
| 新镜像 | `dikw-mbweb:maibo-20261008T004840Z` |
| 新镜像 ID | `sha256:76a417cf2aaa2f10c1fa8cbd560d98f1eb8b31214b1daeb82c3b0379d6e9e349` |
| 前一镜像 | `dikw-mbweb:0.1.10` |
| 发布包 | `/home/prometheus/dikw/brand-releases/maibo-20261008T004840Z/` |
| 私密备份 | `/home/prometheus/dikw/brand-backups/maibo-20261008T004840Z/` |
| 后端 bundle SHA-256 | `acfe4540f049629b431eaffc1f4199a19276bf6bcabcc1fef716ddeb0d50ec3f`（与前一镜像相同） |

构建入口为 `assets/index-DMP-u6Iv.js`、`assets/index-BUiPxFjf.css`，Logo 为 `brand/maibo-pharma-logo.png`。源码补丁与维护方法见 [knowledge-brand](../../knowledge-brand/README.md)。PM 当前镜像仍为 `mb-pm:kb-root-20261006T072035Z`。

## 验证证据及范围

- 本地：ESLint、TypeScript / Vite 构建、格式检查、体积预算、边界 gate 通过；33 个文件、203 项单元测试通过。
- 浏览器：使用明确标注的本地演示数据，核对桌面布局、论文表格、笔记、主题切换，以及 390×844 手机分栏；桌面顶栏计算值为 `rgb(35, 72, 111)`，手机无横向溢出。
- 隔离候选及上线：`/healthz` 200、Docker healthy；匿名 `/v1/base/pages` 401；静态资产仍需身份认证；镜像内 JS / CSS / Logo 哈希匹配发布清单；原 OIDC client、`https://kb.openlims.ai/web/auth/callback` 与 S256 保留。
- 上线保护检查：运行环境按变量名比较，所有值相同；数据 / 会话 / CA 挂载相同；其余 10 个容器 ID 相同。结果保存为服务器 `deployment-summary.json`。
- 公网：内置浏览器可从 KB 首页正常进入 IAM 登录页；命令行公网请求返回 Cloudflare 403，未因此降低任何安全设置。服务健康与资源检查经服务器回环 Caddy 完成。
- **本次尚未验收：** 客户真实账号下的线上阅读、问答、上传、笔记写入和新界面视觉。布局验证没有读取或改写客户数据；不得把本地演示截图称为线上登录后截图。PM 的更新说明源码已补充，但此次没有重建 PM 发布其 HTML。

首个候选检查发现静态资产原本受认证保护，调整为检查匿名 401 并校验镜像内资源，没有开放匿名访问。第一次正式切换因环境变量列表排序变化被误报并自动回退，核实变量名称和值全部相同后改为按名称比较。最终使用全新标签 / 备份重新验证并发布成功；之前尝试的记录保留，最终准确标签以上表为准。

## 验收与回滚

登录门户后打开 KB；强制刷新检查新企业标识、深蓝顶栏及侧栏，分别切换论文研究 / 我的笔记，核对论文内容、问答、主题及手机分栏。验证退出仍回到登录流程；用正常业务账号检查读写权限。

如需回滚，在 `/home/prometheus/dikw` 执行以下步骤，仅恢复镜像版本，不整份覆盖 `.env`，不删除卷：

```sh
# 先确认当前版本仍是本次发布；若已被后续发布替换，应停止并采用其回滚记录
rg '^MBWEB_VERSION=' .env
# 仅将该行由 maibo-20261008T004840Z 改为 0.1.10
sed -i 's/^MBWEB_VERSION=maibo-20261008T004840Z$/MBWEB_VERSION=0.1.10/' .env
docker compose -f docker-compose.yml up -d --no-deps dikw-mbweb
docker inspect dikw-mbweb --format '{{.State.Health.Status}}'
curl -fsS -H 'Host: kb.openlims.ai' http://127.0.0.1:18080/healthz
curl -s -H 'Host: kb.openlims.ai' -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:18080/v1/base/pages  # 匿名应为 401
```
