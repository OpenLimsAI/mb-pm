# 生产前端构建与验收

普通 `npm run build` 仍按现有环境编译，允许生成界面预览产物。它的成功退出不代表产物适合发布，`/health` 返回 200 也不证明登录界面可用。生产发布必须使用下面的入口和最终产物检查。

## 固定源码并构建

从已经合并且 CI 全部通过的固定 main 提交构建；源码归档同样显式传入完整 40 位提交，不使用可变分支名：

```sh
export SOURCE_REVISION="$(git rev-parse HEAD)" # 必须是本次实际构建的固定提交
npm ci
npm run build:production
npm run verify:production-build -- dist
npm run test:production-login -- dist
```

`build:production` 强制设置 `VITE_USE_API=true`、`VITE_API_URL=/api/v1`，即使父进程携带 `VITE_USE_API=false` 也不会产生演示包。`VITE_APP_MODE` 默认留空，由域名区分门户与 PM；独立部署可以显式选 `portal` 或 `pm`，生产校验拒绝开发组合模式 `combined`。不得把共享镜像固定成单一门户模式。

Vite 从**实际解析后的构建环境**生成 `dist/build-info.json`，仅记录真实 API 开关、相对 API 地址、应用模式、源码提交和实际输出文件的 SHA-256，不含运行环境或任何密钥。校验器要求固定 revision 一致，拒绝无清单、演示开关、错误 API 地址、文件缺失/替换及多余旧资源。将目录复制或打包上传后必须再次对最终目录校验，不能用另一个目录的成功记录代替。

`test:production-login` 需要 Chrome（Linux 默认 `/usr/bin/google-chrome`，macOS 默认标准应用路径，其他位置用 `CHROME_BIN`）。它启动仅绑定回环的临时服务，加载**最终编译的页面和脚本**，用 `/portal/me=401` 和无 IAM 会话的公开配置替身模拟匿名浏览器；要求用户名、密码可编辑，提交按钮启用，并实际发出门户 API 请求。不输入真实密码、不发送登录表单、不访问客户 IAM 或数据库。该检查不能替代客户真实授权码、账号权限与 SSO 验收。

## 构建镜像

完整前后端镜像采用标准 Dockerfile，同样通过生产入口：

```sh
docker build --build-arg SOURCE_REVISION="$SOURCE_REVISION" -t "mb-pm:<发布标签>" .
# 本地 Docker Compose 验证也必须传入 SOURCE_REVISION：
SOURCE_REVISION="$SOURCE_REVISION" docker compose up --build
```

仅前端更新时，确认当前后端与本次源码兼容后，可基于准确的当前镜像构建；`Dockerfile.prebuilt` 在独立阶段先校验上传的最终 dist，再替换静态目录，避免遗留旧资源：

```sh
docker build -f Dockerfile.prebuilt \
  --build-arg BASE_IMAGE="mb-pm:<准确当前镜像>" \
  --build-arg SOURCE_REVISION="$SOURCE_REVISION" \
  -t "mb-pm:<发布标签>" .
```

其专用 `.dockerignore` 只允许 dist 和两份校验脚本进入上下文。不要临时手写 `COPY dist` 绕过此阶段。包含后端改动时使用完整标准构建，不能把新前端元数据当作旧后端源码版本的证明。

候选和正式实例还须读取实际 `/code/static` 或导出目录重复校验，并核对公网 `build-info.json` 的 revision、入口页面与脚本 SHA-256 相同。对公网匿名登录页确认输入框可输入、按钮可用，才算完成前端上线验收。保存构建参数、产物摘要、镜像、固定源码及回滚目标；实际部署继续沿用服务器完整 Compose 覆盖组合，保留数据库与已有密钥。

## 防回归与当前状态

```sh
npm run test:production-build
```

自动回归覆盖演示/自定义 API/组合模式、错误 revision、缺失清单、文件被替换、多余资源。CI 的生产构建故意继承一个关闭 API 的环境变量，验证生产入口能够覆盖它，并运行真实编译包的匿名登录表单检查；Docker CI 也传入固定 revision。

这些是代码与流程防线，不能把其合并自动写成“生产已修复”。2026-11-02 事故的线上恢复、实际镜像和验收由对应发布回执单独记录。
