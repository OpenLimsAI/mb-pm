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

`/auth/logout` 或 `/portal/logout` 用服务端当前用户 access POST IdP `/api/sso-logout?logoutAll=true`，仅当标准 introspection 证明同一 token 从 active 变为 inactive 后，浏览器直接返回固定本应用公共 `/login`，同时撤销本服务该主体 PM/门户旧会话。该动作保守影响该身份其他设备。IdP 服务端会话失效后遗留的浏览器 Cookie 不等于有效 SSO，会在真实验收中确认再次登录需要凭据；不宣称物理删除所有跨域 Cookie。上游失败/畸形响应或后置不能确认仍清本地并回 `error=logout_incomplete`，明确提醒其他应用可能仍登录，不宣称全局成功。

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

## 本人状态核验补强

固定 Casdoor v3.152.0 的 introspection 只验证 token 记录与签名/时间，不读取当前 User 的 isForbidden/isDeleted；标准 userinfo 响应也没有这两个状态字段。因此 active=true 不等于账号当前启用，更不等于业务角色实时同步。

现增加第二道只读本人门槛：在本地验签、撤销 marker 和 introspection 通过后，以同一用户当前应用的 access token Header 调用 GET /api/get-user，参数只能是固定 CASDOOR_ORG 与已验 sub 对应的 userId。响应必须 status=ok、data.id 精确等于 sub、data.owner 精确等于固定组织，isForbidden/isDeleted 都须是原生布尔值；缺失/错主体/错组织/非布尔拒绝401，禁用或删除403，服务失败/超时503。不会获取全组织用户、不使用管理员客户端读取、不按用户名或邮箱重绑，不导入角色，也不保存/记录完整 User 响应。

本人 get-user 在固定版本控制器只读 User 与组织规则，不调用 GetAccessTokenByUser；刻意不用 get-account，因为后者没有已有 IdP session token 时会生成并返回新 token。调用禁止跳转、禁用环境代理，不把 token 放入 URL 或转发给浏览器。

新增 CASDOOR_ACCOUNT_STATUS_VISIBLE 默认 false。OIDC_GLOBAL_LOGOUT_ENABLED=true 但该确认 false 时，请求在联系 IdP 前503；global=false 保持兼容。该字段是部署者的明确配置确认，不是程序自动证明：Casdoor GetFilteredUser 可将组织 AccountItems 中 Admin-only 的字段置零，普通用户看见的 false 可能是遮蔽值。因此开启前必须验证本组织两字段对 Self/Public 可见，并以真正禁用的普通合成身份确认接口返回真实状态和应用拒绝旧会话；未知正式组织仍保持默认关闭。变更字段可见性后需要关闭确认并重新验收，禁止静默降级到旧 JWT 状态、管理员权限或 get-account。

此门槛是逐请求动态拒绝，没有 positive cache。禁用时旧会话立即被拒绝；若随后恢复账号，原 token 尚未过期且没有被全局退出撤销时可恢复使用。这不等于永久吊销旧会话。执行统一退出留下的撤销 marker 仍然生效，恢复账号不能使已撤销 token 重新有效。真实验收须分别记录恢复后的旧会话、新登录和全局退出效果。

2026-10-26 补强 TDD：本人状态9项、未确认可见性1项先实际red；第一次生产修改被自动审批按早期范围拒绝，确认未执行，获得拒绝后新的明确授权后仅重试原操作一次并成功。原拒绝没有通过拆分、换工具或管理凭据绕过。随后green49项，追加超时与PM/门户独立cookie禁用恢复回归后52项通过；这些是传输替身单测，不是浏览器E2E。当前整体验收身份配置与实际禁用仍由主任务在获准范围完成。


补强最终本地回归：Linux Python3.11 + 全新隔离PostgreSQL16 465 passed（65.58s），原CI范围覆盖率93.72%，空库001→007再次通过。测试数据库和网络已清理；新增52项均包含在全量中。91个app文件格式及新增状态模块lint通过。本轮没有前端源码变动，因此不重复无变化的前端测试；原276项通过，新生产镜像构建仍运行tsc/Vite。最新镜像 cmc-pm-phase2-e2e:local，sha256:4e4c7846d036a3682138cb83e6c164062731ec5a819f45e6822bc16cc2cf620d，combined+真实API。构建没有启动运行环境；Self可见性配置及真实禁用/恢复仍由主任务在另行获批后验收。

## 真实统一退出 no-op 与成功后置条件

主任务真实浏览器发现第一次全局退出仅使IdP浏览器要求重新登录，门户旧会话仍200。脱敏快照 snapshot-20261026T150848Z-global-logout-first.json 显示同一合成用户五个应用token仍expires_in=3600，PM撤销/重放计数0；不能把IdP登录页当各应用已退出证明。固定源码的 SsoLogout logoutAll=true 应按organization+username过期全部token，空user却返回ok，因此200/status=ok不是充分成功条件。官方source过滤链没有跳过Bearer sso-logout，后续已定位PostgreSQL保留字根因，见“PostgreSQL 根因与官方修复版本”；没有改用管理员权限。

PM新增本人token前置与后置证明：先以本应用标准客户端Basic introspection核对active=true、client_id、sub；再server Bearer调用SsoLogout；仅当同一token再次标准introspection明确active=false才走成功路径。仍active、错主体、超时或无法核验均本地清理并返回logout_incomplete，不再假报全局成功；不把token下放浏览器或放URL，不新增管理权限。此后置仅防误报，不能代替真实跨应用全部失效验收，no-op真正原因和有效全局路径仍需解决。

4项新case先实际red（still_active/status_outage/wrong_subject/inactive），实现后新增回归56项green。Linux全量新隔离PostgreSQL469 passed（58.16s），原CI覆盖93.72%，空库001→007通过，格式/新增服务lint通过。前端源码无变化，生产镜像构建仍包含原tsc/Vite。该修复未重启真实环境；新镜像构建结果另记录，不能使用旧镜像宣称此后置已在运行。

新镜像正常重试构建通过：cmc-pm-phase2-e2e:local，sha256:91ed81bc7c0176d73284798a1e6b972757171f23110b9d46c9a71a95bf3e7b5f，combined+真实API；未替换运行容器。第一次Docker官方语法前端下载EOF已记录为失败，随后同命令重试成功，没有修改网络或安全配置。

## PostgreSQL 根因与官方修复版本

真实验收与独立临时库SELECT复现已经定位：Casdoor 3.152.0 在 GetActiveTokensByUser、ExpireTokenByUser 及通知 GetTokensByUser 的手写WHERE使用未引用的 user。PostgreSQL把裸 USER 解释为 current_user，不是表的"user"列，因此同组织目标用户命中0条、无回调、令牌未过期，但SSO接口仍可返回ok。这不是授权码主体不同、client_credentials或Bearer路由不支持；脱敏IdP审计证明实际actor是测试用户。没有手工把真实token改成0或替代真实注销验收。

官方已在[edfbb9323be4e6ac3a507f08d49fae025431c52f（#5740）](https://github.com/casdoor/casdoor/commit/edfbb9323be4e6ac3a507f08d49fae025431c52f)修复，新增quoteColumn调用当前dialect的Engine.Quote，并修正三个查询。首次正式发布为[3.154.4，2026-08-18](https://github.com/casdoor/casdoor/releases/tag/v3.154.4)；前一3.154.3仍有裸user条件，3.154.4和后续官方版本已修。Cols("expires_in")明确指定零值更新，问题是WHERE误命中，不是0被忽略。[PostgreSQL官方说明USER等于current_user](https://www.postgresql.org/docs/16/functions-info.html)。

本轮决定优先使用官方固定3.154.4在新隔离IdP实例验收，保留旧测试实例/库可回退；不fork身份产品、不换数据库来掩盖问题、不自动升级任何既有正式环境。生产启用前必须具备含该PG修复的受支持固定依赖及完整SSO/注销验收，未知正式环境保持功能默认关闭。实际镜像digest与真实新版本验证由整体验收报告记录，不能把源码修复当已部署证据。

3.154.4还包含官方禁用修复：introspection调用Token.IsUserActive读取当前User，forbidden/deleted/已移除用户返回inactive；用户禁用/删除触发terminateUserAccess撤销token和会话。该能力与3.152.0不同，不能继续把旧版本“introspection不读User”扩展到新版本，也不等于业务角色同步。额外Self字段兼容门槛的最终适用范围须随选定provider版本与真实禁用验收核定，不能为了绕过审批静默开启字段可见性。


## 官方服务端注销后的本应用回跳

官方3.154.4真实验证已经确认全局token失效、signed backchannel成功及MDM/PM/门户旧会话拒绝，但server SsoLogout删掉IdP会话后再让浏览器GET /api/logout不再有当前用户，会返回JSON ok而不跳转。因此成功路径直接返回配置的本应用公共/login，不再依赖第二次IdP GET，也不把任何token放URL或交给浏览器。partial失败仍显示警告，局部退出语义不变。

本次两条成功URL断言先red（仍去IdP）后green，56项创建/身份单元回归通过。一次编辑命令目录错误未改测试，未算red；随后正确运行的两项失败才是有效red。完整隔离PG回归469 passed（87.09s），原CI覆盖93.72%，空库001→007通过；新生产镜像cmc-pm-phase2-e2e:local为sha256:cb2aee79a87023e7c22a9e3e5303c65a39ec4dbb2a0a84dd90e92eba87f29124，combined+真实API，未由本子任务替换运行态。Self兼容检查暂保持原样，待真实禁用证据后的独立决定，不混在这个UX修复里。

## 最终验收状态（2026-10-26，覆盖前述阶段待办）

本轮真实环境已采用官方3.154.4（固定digest见CMC验收报告），无需自定义Casdoor补丁。
额外本人状态核验和Self可见性门槛保留为本实现显式配置契约；不要求应用管理员密钥或组织用户枚举。
没有把旧3.152的introspection限制泛化到新版本，也不自动配置正式组织。

实际浏览器与真实数据库已通过：门户→MDM免重复输入、两组PM创建并一对一关联、双击不重复创建、
远端成功/本地提交失败后同UUID恢复、双向上下文、签名原MDM密码再次认证、错误/未映射/无权限拒绝。
PM的cmc_lead映射MDM只读仍不能调用MDM创建前置接口，返回403，不自动提权。

官方3.154.4上实际禁用creator后，旧MDM/PM/门户会话与新登录均拒绝；恢复身份后旧MDM cookie仍失效，
必须重新认证。该真实版本的禁用会撤销token，前述未撤销有效token可恢复的模拟测试仅为守卫边界，
不能解释为本轮真实禁用后旧会话复活。业务角色变化仍按各端实际会话/重新认证契约，不宣称即时同步。

从MDM统一退出和从PM反向退出都触发实际签名通知/撤销标记，旧应用请求401；PM直接返回本应用login。
IdP故障时业务拒绝，MDM明确提示部分退出，恢复后可重新核验。MDM前端固定本应用回跳的最终误警告也已修复复验。

真实证据、50次截图捕获（45种内容，5静态重复明确排除独立证明）、最终运行镜像/源码hash、清理及发布回执：
[CMC phase2-sso report](https://github.com/OpenLimsAI/cmc-platform/blob/feat/mdm-casdoor-phase2/cmab-mdm-platform/docs/verification/phase2-sso/report.md)。
PM最终运行镜像cb2aee79…，功能提交6c9dd42；本次文档收敛后仍须核对PR最新head的全部CI，不能用旧head代替。
本仓未自动部署生产或修改正式身份权限。
