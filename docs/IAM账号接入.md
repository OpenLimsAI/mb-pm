# Lite 接入现有 IAM

接入代码与测试已完成，IAM 端配置仍待有效管理员登录后执行。未配置前保留 `IAM_ENABLED=false`，此时仍为原演示入口，不提供真实注册。不要运行初始化脚本、重建组织或重置已有用户密码。

## IAM 管理员配置

1. 使用有效管理员登录现有 Casdoor（本机 `http://localhost:8001`）。在现有 `mabpharm` 组织创建专用应用 `mp-pm-lite`，沿用现有 `mp-pm` 的证书、组织与授权码登录配置。记录新应用自己的 Client ID / Client Secret，不修改原应用。
2. 将准确回调地址设为 `http://localhost:5175/api/v1/auth/callback`，退出返回 `http://localhost:5175/login`，开启注册。注册要求用户名、密码、确认密码；可收集姓名和邮箱。注册表单不能允许用户填写角色、管理员标记、权限或组织。
3. 新注册用户不分配任何高权限业务角色；Lite 对无角色账号按 `rd` 处理，且默认无项目成员关系。管理员按实际需要分配项目和业务角色。
4. 在账号字段配置中允许用户自行修改 Name（用户名）和 Password；身份 ID、组织、管理员标记、角色与权限保持仅管理员可改或不可改。这些是组织级设置，保存前确认对原应用的影响。用户保存新用户名后再改密码。
5. 保留现有 `admin`、`guo.cmc` 等账户及其角色、用户名、密码和稳定身份 ID。禁止删除重建这些账户。

## Lite 配置与启动

在 `backend/.env` 写入如下配置（不要覆盖已有数据库配置）：

```dotenv
IAM_ENABLED=true
CASDOOR_ENDPOINT=http://localhost:8001
CASDOOR_APPLICATION=mp-pm-lite
CASDOOR_ORGANIZATION=mabpharm
CASDOOR_CLIENT_ID=填写新应用的值
CASDOOR_CLIENT_SECRET=填写新应用的值
PMS_PUBLIC_URL=http://localhost:5175
APP_SECRET=替换为随机且固定保存的至少32字符密钥
IAM_COOKIE_SECURE=false
```

`.env` 应限制为仅当前服务用户可读。HTTPS 部署设 `IAM_COOKIE_SECURE=true` 并统一修改公开地址、回调地址及反向代理；不要使用演示模式对外部署。前端采用 `VITE_API_URL=/api/v1`，开发代理指向 Lite 后端 8015。重启后端与前端后生效。

## 验收

- 未登录只能进入登录页，可跳转 IAM 自助注册。新用户首次登录为研发角色，项目列表为空，不能使用 AI 设置或管理项目。
- 管理员和郭主任首次登录将与既有业务用户按受限的已知用户名及角色绑定，保留业务用户 ID、项目和历史数据。
- 同一 IAM 身份改名后重新登录仍关联原业务用户 ID。已绑定用户通过稳定的 issuer + subject 识别，不按邮箱合并账户。
- “我的账号”跳转现有 IAM 的 `/account` 页面修改自己的用户名和密码，完成后重新登录同步。
- 启用 IAM 后关闭旧用户名直登、演示 Bearer 和本地 HS256 令牌路径；会话使用 HttpOnly Cookie，写操作校验同源 Origin。
- 自动测试覆盖 JWT 验签与声明、最低角色、已有身份保留、改名关联、登录回调与重放防护、Cookie 会话、同源校验和退出。真实 IAM 注册与个人修改仍需在管理员完成以上配置后验收。
