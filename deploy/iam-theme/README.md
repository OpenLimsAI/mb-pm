# 迈博本地 IAM 蓝色主题

这里保存 Casdoor 登录样式与本地应用工具，配色与工作台 Blue Edition 一致：主蓝 `#1E466B`、浅蓝 `#67BAF4`、柔白 `#FAFAFA`、近黑 `#0D0D0D`。

## 文件与适用范围

- `forest-login.css` 是登录样式源文件；文件名保留历史兼容含义。
- `application-theme.patch.json` 仅包含 `themeData`、`formCss`、`formCssMobile`。
- `organization-theme.patch.json` 仅供组织主题字段审阅；本地工具不更新组织记录。
- `apply-local-theme.py` 固定访问 `http://localhost:8001`，只处理已存在的 `mp-pm` 与 `dikw-kb-local`，组织必须为 `mabpharm`。

补丁的两个 CSS 字段按官方 `formCss` 入口使用 `<style>` 包装。修改源 CSS 时应同步更新两个补丁字段，测试会检查它们与源文件一致。

工具不会创建应用、账号或角色，不提供生产地址、任意应用名或关闭认证的选项。

## 使用已有本地配置

使用已经安装 `httpx` 的 Python 环境。通过文件路径传入现有私有初始化配置，不把密钥填在命令行中。配置采用现有 `applications` 列表格式，其中 `mp-pm` 记录应有 `owner`、`organization`、`clientId` 和完整 `clientSecret`。

```sh
python deploy/iam-theme/apply-local-theme.py \
  --config /absolute/path/to/private-local-iam-config.json \
  --backup-dir deploy/iam-theme/private
```

这两个路径都是显式参数，不再依赖某个工作副本的目录位置。也可选择仓库外的私密备份路径；已有备份目录必须属于当前用户且权限为 `0700`。仓库内备份路径必须被 Git 忽略，工具会拒绝可能被提交的路径。

执行前，工具通过官方接口读取两个应用，确认应用名称、组织、归属及完整密钥，并将原记录保存为 `0600` 备份。两个原记录都安全保存后才写入主题，`themeData` 采用合并方式。每次写入后回读并比较，主题以外的字段必须完全一致。

如更新或回读失败，工具尝试恢复本次已尝试写入的全部应用并验证恢复结果。若无法确认恢复，停止并保留私密备份，需检查后再重试。终端仅输出不含凭据的回执；详细原记录始终留在私密目录内。

私有初始化配置、`private/` 原始应用记录及任何凭据都不能提交。执行工具不会完成真实账号浏览器验收；应用后仍需从 `http://localhost:1234` 的正常登录入口核对登录、回调、桌面/窄屏和明暗主题。

## 本地验证

测试使用合成配置与内存 HTTP 模拟，不读取已有配置、不调用本机 IAM、不改变真实应用。

```sh
python -m unittest discover -s deploy/iam-theme -p 'test_*.py' -v
```

字段及选择器的实现依据为 Casdoor v3.100.0 的官方 [ThemeData](https://github.com/casdoor/casdoor/blob/v3.100.0/object/organization.go) 与 [LoginPage 表单样式入口](https://github.com/casdoor/casdoor/blob/v3.100.0/web/src/auth/LoginPage.js)。升级 Casdoor 后应重新核对实际登录页选择器。
