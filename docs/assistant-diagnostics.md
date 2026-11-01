# 个人助手请求诊断

每次通过身份和输入校验的消息请求生成独立 `diagnostic_id`。同一问题重试保留客户端 `request_id`，每次尝试有不同诊断编号，方便区分失败与重试；成功请求在 `X-Assistant-Diagnostic-ID` 响应头中返回编号，服务端失败提示中直接显示。页面自身超时/断网时显示原请求 UUID，运维也可用该编号查询后台是否仍在处理或已保存。

这套日志用于查明失败原因，没有改变模型时限、输出额度、自动重试或分批逻辑。既有失败若未留下细节，无法事后恢复；需上线后复现。

## 能区分什么

| 类别 | 判定依据 |
|---|---|
| `model_timeout` | 模型连接、等待或读取触发 TimeoutError；URLError 包含超时原因也会识别 |
| `output_limit` | 模型 `finish_reason` / Ollama `done_reason` 为 `length` |
| `response_too_large` | 接收字节数或本地正文容量达到上限 |
| `model_auth` / `model_rate_limit` | 上游明确返回 401/403 或 429；429 无法单凭状态区分额度不足与频率限制 |
| `model_network` | 网络、DNS、连接中断等非超时错误 |
| `model_invalid_response` / `model_empty_response` | 模型结果无法解析或未返回正文 |
| `query_timeout` / `query_limit` | 整轮知识查询的总时间/工具次数达到上限 |
| `dependency_*` | 知识库等依赖不可用；结合 `stage` 判断发生位置 |
| `unexpected_error` | 未预期的系统异常，保留编号供定位，不输出异常原文 |

每次尝试记录开始和结束、处理阶段、工具名及耗时、模型每轮耗时与时限、输出额度、结束原因、模型返回的 token 用量及 HTTP 状态。未提供的元数据保留为空，不推测超时或超限。查询参数、路径、论文标题、问题、正文、推理内容、回答、用户身份、端点 URL、密钥、原始异常和调用栈均不写入该诊断日志。

已识别的输出容量问题使用 422，模型或依赖暂不可用使用 503；不将这些业务失败作为 502/504 网关错误返回，避免入口代理替换错误正文和编号。原依赖状态在 `dependency_status` 中保留。真正的入口异常仍可能遮蔽响应，此时页面使用原请求 UUID 查询后台。

## 运维查询

日志由专用 logger 写入容器标准输出，不新增公开查询接口。使用已有 SSH 运维权限查询；不把完整运行配置或凭据发给用户。

```sh
# 在持有源码的运维环境；文件路径按当前发布目录调整。
reader=releases/当前发布标签/scripts/read-assistant-diagnostics.py
docker logs --since 1h mb-pm-v2-app-1 2>&1 | python3 "$reader" --failures
docker logs --since 1h mb-pm-v2-app-1 2>&1 | python3 "$reader" --id '页面中的诊断编号或请求编号'
# 直连入口同样查询 mb-pm-v2-app-direct-1。
```

例如 `model_completed` 记录 `finish_reason=length`、随后 `request_failed.code=output_limit`，即确认回答达到输出上限；`model_failed.code=model_timeout` 则是模型等待/读取超时。两者不能仅靠耗时猜测。仅有页面等待超时不说明后台也超时，要用 request_id 核对后台事件。

## 保存与容量

生产两应用的 Docker json-file 日志各限制为每文件 10 MB、最多 5 个文件；不是按天保留，旧文件会轮转覆盖。重建容器也会移除旧容器日志。发布前须将现有诊断 JSONL 导出到权限 0600 的发布备份目录；主部署指南已补充命令。它不是永久日志归档，也没有新增数据库表、监控平台或自动告警。

本次按分类、隐私、重试、并发及前端编号显示做测试。生产部署及真实问题复现结果以独立发布记录为准；本地模拟测试不等于真实模型验收。
