# MDM Casdoor 与创建并关联：PM 侧实施记录

本文件描述第二阶段 PM 侧代码与本地自动校验。真实 Casdoor 登录、浏览器跨应用创建和退出验收由整体验收报告另行记录；以下单测和镜像构建不能替代该验收。本仓没有在本阶段自动部署生产或修改正式身份配置。

## 边界与配置

MDM 管登记治理，PM 管执行。两侧保留自己的 ID、业务状态、计划和审计；不跨库写入、不按名称或编号猜测关联、不复制预算和团队。指定负责人不会改变其角色。MDM 角色不授予 PM 权限，PM 管理员也不因此获得 MDM 管理权限。

- `MDM_DELEGATION_CLIENT_ID` 默认空：启用时必须是独立标准 OAuth 用户委托客户端，与 PM、门户及 MDM 登录客户端分离。空值或与 PM/门户重用时拒绝。
- `MDM_SOURCE_NAMESPACE` 默认 `mdm`：服务端固定来源，收到不同 source_id 返回 400；浏览器不能选择来源。
- `OIDC_GLOBAL_LOGOUT_ENABLED` 默认 false：启用新统一退出、已验签 backchannel 和逐请求 RFC7662 active 核验。
- PM 和门户各自客户端配置回调 `POST /api/v1/auth/backchannel-logout`，按精确 audience 验签；URL 取相应环境服务地址，不写凭据。
- 入口卡片使用中性文案，实际 MDM 登录方式取 MDM 配置；前端不会据入口推定已经单点登录。

独立委托 JWT 只在下列三个集成接口和原项目 `integration-reference` 接口接受，普通 PM 接口原 audience 不放宽。先验签、校验 issuer/exp/audience，再按 issuer+subject 查已存在的 PM 身份（不在集成 API 自动建用户、不按邮箱/同名绑定）。用户需有效，并符合本组织。创建、候选与回执查询仅 PM `admin` / `cmc_lead`。

## 创建与恢复契约

`GET /api/v1/integration/mdm/owners` 返回：

```json
{"items":[{"id":"existing-user","display_name":"合成示例"}],"current_user_id":"caller","options":{"product_types":["单抗","多抗","其他"],"stages":["临床前","IND","Ph1/2","Ph3","BLA","商业化","上市后"]}}
```

仅返回现有有效用户的 ID/显示名；界面须显式选择，不能按名字猜 ID。词典以该端点为准。

`POST /api/v1/integration/mdm/projects` 请求：

```json
{"request_id":"00000000-0000-4000-8000-000000000001","source_id":"mdm","source_project_id":"123","project":{"code":"EXAMPLE-001","name":"合成示例项目","product_type":"单抗","current_stage":"IND","target_stage":"Ph3","owner_id":"existing-user","planned_start":"2026-11-01","planned_end":"2027-06-30","description":"可选"}}
```

request_id 为稳定 UUID，source_project_id 为正整数字符串；project 内除 description 外均必填。结束日期不得早于开始日期。额外字段拒绝；不接受预算、成员、模板或状态强写。PM 定义新项目初始状态为“活跃”、健康 green、进度 0，不生成虚构里程碑/阶段/预算。

成功回执包含 `request_id/source_id/source_project_id/project_id/code/name/status/bindable/created_by`，另有 `project:{id,code,name,status,bindable}`；嵌套与扁平字段一致。ID 为真正落库的 PM project ID。

| 行为 | 状态码及结果 |
| --- | --- |
| 首次创建 | 201，项目+回执+审计同一事务提交 |
| 原请求同参重试 | 200，返回同一项目 |
| 同请求异参、同登记另请求、既有项目编号碰撞 | 409，不自动关联 |
| 回执查询 `GET /projects/{request_id}` | 200；不存在或非原操作者为 404 |
| 缺委托配置、当前状态服务不可达 | 503 |
| 错受众/无身份、无创建权 | 401 / 403 |
| 无效或停用负责人、错误日期/输入 | 422 |

PM 持久化唯一请求 UUID、唯一 source_id+source_project_id、唯一 project_id 与参数指纹。PostgreSQL 按请求/来源/编号取得稳定排序的事务 advisory lock，数据库约束作最终防线；异常时整体回滚。网络超时后 MDM 应持原 UUID 查询回执，远端已成功而本地关联失败时按回执恢复，不生成新 UUID。回执仅向原创建者返回，换人恢复须显式人工对账。

带创建回执的 PM 项目普通 DELETE 返回 409，避免删除后留下幽灵关联；正式解除/删除流程需另行协调保留与对账，当前不提供自动删除。

## 统一退出的精确语义

固定 [Casdoor v3.152.0 token_logout.go](https://github.com/casdoor/casdoor/blob/v3.152.0/object/token_logout.go) 和 [controllers/token.go](https://github.com/casdoor/casdoor/blob/v3.152.0/controllers/token.go) 为本阶段版本依据。应用字段为 backchannelLogoutUri，provider 用标准 form logout_token 通知。验证 RS256/kid、精确 issuer、单一已配置 PM/门户 audience、近 5 分钟 iat、jti、events、sub 或 sid；拒绝 nonce、错误事件和身份空值。固定版本事件无 exp，因此按 iat 时窗和持久化 jti 防重放，不凭空要求 provider 未提供的声明。

该版本 SsoLogout 即使 logoutAll=true 仍附当前 Beego sid。因此采用保守策略：有 sub 的已验签事件撤销该应用该主体全部既有会话/令牌，即使 sid 与实际浏览器不同；不声称选择性退出某个 sid。仅有 sid 时精确匹配。新 token 的 iat 必须晚于 marker，秒级同刻保守拒绝。PM 委托还尊重本服务 PM/门户的该主体 marker。相同通知重放幂等，同 jti 异参数拒绝，错误通知不产生撤销。

启用开关后，所有 PM/门户 cookie 与普通 bearer、专用委托 API、登录回调在本地 JWT 校验后逐次调用 `POST /api/login/oauth/introspect`，传 form token 和 token_type_hint=access_token，使用对应 PM/门户客户端 HTTP Basic。要求 active=true、实际 client_id=预期受众、sub 一致；不可达或服务格式错误 503，inactive/错主体/错客户端 401。不缓存 active，补上异步回调漏送的窗口。委托使用 PM 自己客户端查询：固定版本以查询应用证书验签，测试环境同证书可行；不同证书安全拒绝，不共享 MDM secret、不增加管理 API 权限。此检查不等于角色实时同步，业务授权仍按现有 PM 角色契约。

`/auth/logout` 或 `/portal/logout` 用服务端当前用户 access POST IdP `/api/sso-logout?logoutAll=true`，随后浏览器到不含 token 的 `/api/logout?client_id=...&post_logout_redirect_uri=固定login` 清 IdP 浏览器会话，同时撤销本服务该主体 PM/门户旧会话。该动作保守影响该身份其他设备。上游失败/畸形响应仍清本地并回 `error=logout_incomplete`，明确提醒其他应用可能仍登录，不宣称全局成功。

`/auth/logout/local`、`/portal/logout/local` 只清当前浏览器对应应用会话，不调用 IdP、不清另一应用 cookie；回 `login?local=1&app=...`，避免立即自动 SSO 重新进入。统一退出与局部退出都要求正确 Origin。回调和退出响应 no-store/no-referrer；访问日志剔除 PM/门户授权回调 query，避免记录 code/state。

默认关闭时保留既有本地清理和 IdP 浏览器退出行为，同时移除原有 id_token_hint，PM/门户两种模式退出 URL 都只带客户端及固定回跳。已核实 [v3.100.0 controllers/account.go](https://github.com/casdoor/casdoor/blob/v3.100.0/controllers/account.go)：无 hint 时按既有 IdP 浏览器 session 识别身份，session 应用缺失可按 client_id 取应用并验证已登记回跳。若 IdP 当前已无会话，该版本直接返回 JSON 而不回跳；这项固定源码兼容核查不等于 3.100 真实全量 SSO 验收。开启时先调用 server sso-logout 是否影响随后浏览器回跳也必须实测。真实浏览器须分别检查 MDM、PM、门户与 Casdoor 的会话状态，不把物理 Cookie 删除与服务端会话失效混称。

## 迁移与回退

新增 Alembic 007：mdm_project_receipts、oidc_revocations、oidc_logout_replays。只增加新表，不改历史用户 ID/业务审计。迁移文件不等于获准对现有共享库运行；本次仅对新建隔离空库执行 001→007。应用会 create_all，因此正式迁移应在切换应用前按既有运行约定规划，不能对未知库直接重复建表或重建。

可先关闭新配置并回退应用，保留三张新表。007 downgrade 对三表加锁并检查，任何非空记录均拒绝删除，防止丢失创建幂等或撤销状态；非空库的回退必须单独制定保留方案。

## TDD 与实际本地校验

2026-10-26：

1. 首轮路径/夹具准备失误未当作 red。有效首轮 19 项失败（新路由缺失、委托引用受众未实现）后才实现，随后 19 green。
2. signed sub + 不同 sid、局部退出 2 项先 red 后 green；并发同请求与删除回执保护 2 项先 red 后 green。审计故障整体回滚和 provider 成功/失败为已有实现补回归，不伪称先 red。
3. callback 日志缺模块 1 red；门户独立 JWKS 和旧委托重放 2 red；introspection 6 red（包括远端 inactive 无本地 marker 时仍可进入）后实现；畸形注销响应 1 red 后修复。
4. 前端局部退出/错误提示 2 red→green，中性 MDM 入口断言 1 red→green；默认关闭模式两端无 URL token 2 red→green。错误通知/其他主体不受影响为已有实现追加回归，不伪称先 red。
5. 新增后端共 39 项，已包含在最终全量 PostgreSQL 通过结果中；移除旧 URL token 前新增 36 项 SQLite 已通过，移除后 PM/门户 PKCE/会话/CSRF 相关合计 123 项 SQLite 回归通过。这里用合成 RSA、测试数据库及明确 HTTP 传输替身；不是真实身份或浏览器验收。
6. 当前全部后端在 Linux Python3.11、PostgreSQL16 新临时库：452 passed（50.50s），原 CI 范围 accounts/portal 分支覆盖合计 93.72%，达到原 90% 门槛。此前只读源码挂载的 .coverage 输出错误已改容器 /tmp，另一个 PG 才暴露的新测试 ID 超 20 字符错误只修夹具，未扩大业务 ID。
7. Linux Node20 全量前端 21 文件 / 276 测试通过，原覆盖率门槛通过；总体语句 98.54%、分支 96.54%。eslint、门户路由、tsc+Vite build 通过。
8. 91 个 app Python 文件 ruff format 通过，所有新增生产模块 ruff check 通过。全仓 lint 为 152 个存量提示，与 origin/main 9604866 的只读导出基线逐类别一致（B008 136、I001 5、UP017 5、F401 1、B023 2、N806 3），没有降级规则或新增提示。
9. 空白 PostgreSQL 001→007 迁移通过；所有本次自动测试 PG 容器/网络均停止清理，没有端口发布。
10. 新 E2E 镜像 cmc-pm-phase2-e2e:local 构建通过，VITE_APP_MODE=combined、VITE_USE_API=true，镜像 sha256:0b9a71a44aad877048c20ba43f424badf7db2abeb6b95a17abd53f1d98f3aa93。该构建不代表真实 E2E 已完成；运行、配置和清理由主任务统筹。

本阶段完整浏览器证据、测试数据范围、脱敏截图/哈希、PR 最新 head CI、合并 SHA 及验收环境清理仍由整体验收追加。没有这些证据前，不将本文件的自动测试结果宣称为已完成用户端到端目标。
