# 文件夹导入的 Core 扩展

这是知识源自动导入配套的服务端扩展，要求 `dikw-core==0.6.10` 和已审查的 `api_ingest.py` SHA-256。启动时检查两者，不兼容时停止启用；不修改已安装的依赖文件，不替换普通 Python 引擎 API 的全局变量。

## 能力与边界

扩展镜像沿用 amd64 版 Core 0.6.10，构建时校验 Debian 安全仓库的 apt、libapt-pkg7.0、zlib1g 安装包以及 PyPI certifi 证书包的 SHA-256。安装阶段离线运行，服务进程继续使用原有的 `dikw` 用户。

- `GET /v1/folder-import/capabilities` 提供精准索引和原子版本切换能力声明。
- `POST /v1/folder-import/ingest` 只处理请求中的一个已导入 Markdown 版本，沿用 Core 的解析、分块、向量写入、任务和事件处理。补建缺失向量也限制在该文档。
- 新版在全文和向量确认完成前不可检索；原子更新版本指针后启用新版。旧版没有其他来源引用时退出默认检索，原件和正文保留。
- 同内容的已完成文档只新增来源绑定，不重新分块或调用向量模型。外部覆盖已索引的不可变路径会明确失败。
- `GET /v1/folder-import/version?path=...` 允许持有 Core 服务凭据的知识库服务读取已登记的历史正文。浏览器不接收 Core 凭据，业务权限由知识库再次检查。
- 扩展同时接管 HTTP `POST /v1/ingest` 的执行器，使手动全库增量扫描跳过未就绪和已取代的自动导入版本，防止再次激活旧版；手动操作的普通文档继续处理。
- 所有新增接口使用原有 Core Bearer 验证。业务库增加两个独立的版本元数据表，不删除或重建既有资料、索引或模型配置。

目前真实运行验收使用 SQLite。PostgreSQL 实现包含事务和版本族锁，但尚未连接实际 PostgreSQL 验收。**一个知识库必须只有一个 Core 写入进程，且所有写入入口使用此扩展服务**；不能让独立的未扩展 Core、命令行原地 ingest 或其他副本并发写同一个库。内存锁并不提供多 Core 进程写入协调。

## 启动

生产候选使用本目录的 `Dockerfile`，以已验证的生产 Core 镜像作为 `CORE_BASE`。容器继续使用原有的 `serve` 参数和数据挂载。发布前在隔离 PostgreSQL 上检查单篇导入、版本切换、检索和普通全库索引。

沿用已有 Core 的环境、模型配置、数据库及持久化 base，只将服务入口替换为本目录的 `run.py`：

```sh
python extensions/knowledge-folder-core/run.py --base /path/to/existing-base --host 127.0.0.1 --port 8765
```

Core 服务凭据通过既有 `DIKW_SERVER_TOKEN` 环境变量提供，不写入命令行。绑定非本机地址仍要求凭据。知识库的 `DIKW_CORE_URL` 指向这个同源 Core；不改变门户浏览器入口 `http://localhost:1234`。

仅在隔离副本通过能力握手、权限、十份 PDF、重复扫描、新版失败和成功切换、历史原件及检索验收后，才能切换客户运行入口。本轮代码未部署到生产。

## 验证

在已安装该固定 Core 及依赖的 Python 环境中：

```sh
python -m unittest discover -s extensions/knowledge-folder-core -p test_folder_core.py -v
python -m unittest discover -s scripts -p test_knowledge_folder_connector.py -v
```

测试使用临时 base 和确定性的本地向量替身，真实运行 Core 分块、SQLite 向量存储、检索、版本切换和任务回执，不调用付费模型。

完整 PDF 验收入口是 `scripts/verify-folder-import-stack.py`。它需要配套知识库的 `scripts/folder-import-acceptance.ts` 构建产物，依次运行真实 PDF 解析子进程、HMAC 桥接、Core 索引、本地连接程序的 HTTP 配对与文件上传，以及真实检索路由。IAM 身份和向量供应商使用明确隔离的测试替身；临时数据不会替换现有本地或生产知识库。
