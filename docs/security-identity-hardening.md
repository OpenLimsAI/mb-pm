# 身份与会话加固（2026-11-02）

## 授权与登录回调

启用 `OIDC_GLOBAL_LOGOUT_ENABLED` 时，每次请求先验签，再用当前应用凭据调用 IAM `POST /api/login/oauth/introspect` 校验 active、client_id、sub，并用该用户的 access token 查询 `GET /api/get-user?owner=...&userId=...`。本次请求的角色来自实时账号数据，登录时 JWT 中的旧管理员角色不再继续授权。IAM 暂不可用返回 503，不清除浏览器会话。

无效或无对应 state 的 OAuth 回调只结束临时登录事务，不删除已有项目管理或门户登录会话。

## 修改与重置密码

本人改密和管理员重置都会先核对 IAM 会话列表接口可用。密码写入后，本系统立即撤销该 subject 的所有 PM/门户 cookie 会话，并写入多实例共享的撤销时间标记；随后删除该用户在 IAM 的全部 SSO 会话和 access/refresh token 记录，并重新查询确认清理完成。成功返回 204，当前浏览器也需重新登录。不再保留发起改密的会话。

密码写入和跨服务会话删除不是同一数据库事务。若后续 IAM 清理失败，接口明确返回 503“密码已修改/重置，但统一身份会话撤销未完成”，本地撤销仍持久保存；此时不得把操作报告为成功或要求用户重复提交旧密码，应由管理员确认并完成目标账号的授权清理。

新账号与管理员重置使用 IAM 的 `needUpdatePassword=true`，直接进入知识库或 IAM 同样必须先修改临时密码。账号“修复”不会清除此要求。本系统保留历史本地标记，只有核实 IAM 的新改密时间晚于该标记后才清除。

每次授权同时检查 `lastChangePasswordTime`。可续期会话比较首次认证的 `authenticated_iat`，不能使用刷新后的 `iat`。缺少原始认证时间的旧续期会话需要重新登录一次；已有数据不受影响。Casdoor 原生改密页面的 token/SSO 撤销由 IAM 对应发布补丁完成，应用侧时间校验不能替代源端撤销。

## 部署前提

- 保持 `OIDC_GLOBAL_LOGOUT_ENABLED=true`。
- `CASDOOR_ACCOUNT_STATUS_VISIBLE=true` 仅能在确认组织 AccountItems 对本人提供真实 `isForbidden`、`isDeleted`、`roles`、`needUpdatePassword`、`lastChangePasswordTime` 后设置；仅字段存在和类型正确不能证明未被 IAM 零值掩码。
- IAM 管理客户端须能在本组织查询并删除目标用户的 tokens 和 sessions。代码对查询返回再次核对组织和精确用户名，删除请求只发送记录标识，不传回 token 密文。
- 使用专用验收账号检查：角色降权后旧 token 被拒绝；改密/重置后旧 access 不活跃、旧 refresh 不可用、PM/门户/知识库旧 cookie 不可用；新密码重新登录可用。不得以 mock 测试替代这项真实验收。

## 助手知识历史

仅使用知识库的历史答案也在读取时重验知识库访问权。权限撤销或 IAM/知识库配置核验失败时不返回旧答案。新元数据记录只按实际 `used_sources` 验权；旧记录缺少来源证明时，按保守的历史数据来源核验。已有项目历史范围校验继续生效。
