# 个人助手后台生成（2026-11-02，America/New_York）

用户明确要求实施、提交main并部署生产。新页面使用持久请求和短轮询，展示真实阶段和官方DeepSeek正文片段；刷新/断网读取同一次请求，失败保留输入。请求由两个实例通过数据库原子认领，同任务加锁，完成消息/产物和请求状态原子保存；运行租约过期不自动重复调用模型。保留既有应用范围、历史权限和敏感内容边界。旧同步接口兼容。

## 固定版本和发布边界

遵循PR→最新提交全部CI通过→squash merge，从首次将本记录合入main的固定提交构建。采用标准Dockerfile，SOURCE_REVISION完整40位，build:production强制真实相对API和域名模式。校验镜像内部实际产物清单、文件摘要与源码；导出该镜像实际静态目录进行匿名登录浏览器验收，不用另一个本地构建代替。部署及运行版本以服务器releases/assistant-async-<固定提交前七位>-20261102/{image,operations,verification}.json为准，成功前不宣称已部署。

发布前基线及回滚为已修复登录的mb-pm:login-build-fix-1b2cbe5-20261102，ID sha256:ce175a32c80898886a44d790839b26babb75a35d49e5746357f2686c4cee2383；不回滚到已知关闭API的旧助手镜像。保留最新main50997e6的构建与登录防回归。切换前再次核对基线并使用全局发布锁。

## 迁移、验证、回滚

016只新增assistant_requests及assistant_tasks.active_request_id，不改写旧任务、消息和资料。备份数据库、模型和完整配置，隔离生产库先执行固定016脚本的定向新增操作和重复迁移校验，再验证后台请求生命周期与真实公开问题；历史库没有完整Alembic台账，禁止从base重放整条迁移链或伪造台账；候选自动worker关闭，由验收程序明确执行，不写生产任务。新后台请求总时限默认300秒，官方DeepSeek连接15秒、读取空闲120秒，普通问答较低思考强度8192token，明确深入分析16384token；非流式模型仍遵循总时限，不展示推理正文。

正式切换前禁止有运行中的助手或知识源下载任务，导出旧诊断、重新备份并升级至016后更新app/app-direct。两个实例均须验证真正的ASGI worker启动日志、健康、匿名鉴权、知识库只读连接、生产静态清单、旧表记录ID/完整消息摘要/模型设置及其他容器不变。实际全量测试、候选真实模型及生产登录/公网验收分别记入回执，不互相替代。

完整七份Compose：compose.yml、compose.production.yml、compose.direct.yml、releases/header-9516977/compose.no-note-sync.yml、releases/assistant-dikw-e294fdc/compose.knowledge.private.yml、releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml、releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml。新目录compose-production.sh为运维入口。仅更新两个PM，保留私有配置、原件、模型及其他服务。

回滚不恢复业务库、不执行downgrade。若新worker已接受请求，先用数据库状态和任务槽位阻止在途进程继续保存，将未完成请求明确标记中断并保留输入，再切回已验证登录镜像。016表和已完成消息仍保留，为再次升级保留恢复依据。私有备份留在private-config-backups/<标签>/，不提交到GitHub。

## 实际生产回执

2026-11-02已完成上线，代码PR #122，固定main `0d7fa1d5794549f7fa286846c729a74539bfe2fe`，镜像 `mb-pm:assistant-async-0d7fa1d-20261102`，ID `sha256:695bbab97e78773ffc3993693066b5185145dfc901f60b59a0193f4129b10174`。PR五项CI全成功；本地PostgreSQL1109项、前端736项全通过，账号覆盖93.65%。标准Dockerfile构建的最终镜像162份文件清单校验及实际包匿名登录浏览器通过。

隔离公开问题实测：HTTP202约0.017秒受理，真实DeepSeek约42.685秒完成，观察到正文片段持久保存；相同编号重放未再次生成，一次模型调用、零搜索/知识库调用，1991字符答案和产物原子保存。未修改正式用户任务，隔离容器与测试库已清理。

旧库无完整迁移台账，隔离整链升级因重复users表失败后停止；正式库未重放该失败链。实际核对既有助手015字段后，用固定016脚本的Alembic Operations在事务中执行upgrade两次，仅新增请求表和任务槽位，历史台账保持原样。正式库同样完成该定向升级；回滚不downgrade、不恢复旧库。

两个正式实例healthy，真实ASGI后台worker启动日志通过，无dispatch错误。39张表原有ID与完整助手消息摘要、企业模型配置保留，其他15容器不变；完整七份Compose保持。源站及回环IP入口200，生产build-info匹配固定源码，匿名任务API401。公网自动清单探测结果和真实客户SSO访问分别验收，不以本地模拟登录冒充真实账号登录。

备份：`/home/prometheus/mb-pm-v2/private-config-backups/assistant-async-0d7fa1d-20261102/`。固定源码、当前执行脚本、构建/迁移/候选/正式/入口回执及运维wrapper：`/home/prometheus/mb-pm-v2/releases/assistant-async-0d7fa1d-20261102/`。最终镜像静态包SHA256为`04f786a16d8a7b9a0e77393a47c457f61b76391edd891f0e3d25a24bd428b6ca`。回滚镜像为上述已修复登录基线，保留016及请求数据；本次未实际回滚生产。
