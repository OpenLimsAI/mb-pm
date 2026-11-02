# 个人助手后台生成（2026-11-02，America/New_York）

用户明确要求实施、提交main并部署生产。新页面使用持久请求和短轮询，展示真实阶段和官方DeepSeek正文片段；刷新/断网读取同一次请求，失败保留输入。请求由两个实例通过数据库原子认领，同任务加锁，完成消息/产物和请求状态原子保存；运行租约过期不自动重复调用模型。保留既有应用范围、历史权限和敏感内容边界。旧同步接口兼容。

## 固定版本和发布边界

遵循PR→最新提交全部CI通过→squash merge，从首次将本记录合入main的固定提交构建。采用标准Dockerfile，SOURCE_REVISION完整40位，build:production强制真实相对API和域名模式。校验镜像内部实际产物清单、文件摘要与源码；导出该镜像实际静态目录进行匿名登录浏览器验收，不用另一个本地构建代替。部署及运行版本以服务器releases/assistant-async-<固定提交前七位>-20261102/{image,operations,verification}.json为准，成功前不宣称已部署。

发布前基线及回滚为已修复登录的mb-pm:login-build-fix-1b2cbe5-20261102，ID sha256:ce175a32c80898886a44d790839b26babb75a35d49e5746357f2686c4cee2383；不回滚到已知关闭API的旧助手镜像。保留最新main50997e6的构建与登录防回归。切换前再次核对基线并使用全局发布锁。

## 迁移、验证、回滚

016只新增assistant_requests及assistant_tasks.active_request_id，不改写旧任务、消息和资料。备份数据库、模型和完整配置，隔离生产库先执行alembic upgrade016、重复迁移校验、后台请求生命周期与真实公开问题验收；候选自动worker关闭，由验收程序明确执行，不写生产任务。新后台请求总时限默认300秒，官方DeepSeek连接15秒、读取空闲120秒，普通问答较低思考强度8192token，明确深入分析16384token；非流式模型仍遵循总时限，不展示推理正文。

正式切换前禁止有运行中的助手或知识源下载任务，导出旧诊断、重新备份并升级至016后更新app/app-direct。两个实例均须验证真正的ASGI worker启动日志、健康、匿名鉴权、知识库只读连接、生产静态清单、旧表记录ID/完整消息摘要/模型设置及其他容器不变。实际全量测试、候选真实模型及生产登录/公网验收分别记入回执，不互相替代。

完整七份Compose：compose.yml、compose.production.yml、compose.direct.yml、releases/header-9516977/compose.no-note-sync.yml、releases/assistant-dikw-e294fdc/compose.knowledge.private.yml、releases/knowledge-sources-687bddc-20261101/compose.knowledge-sources.yml、releases/deepseek-search-99ca39d-20261101/compose.deepseek-search.yml。新目录compose-production.sh为运维入口。仅更新两个PM，保留私有配置、原件、模型及其他服务。

回滚不恢复业务库、不执行downgrade。若新worker已接受请求，先用数据库状态和任务槽位阻止在途进程继续保存，将未完成请求明确标记中断并保留输入，再切回已验证登录镜像。016表和已完成消息仍保留，为再次升级保留恢复依据。私有备份留在private-config-backups/<标签>/，不提交到GitHub。
