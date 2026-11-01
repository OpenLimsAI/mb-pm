# 模型选择与价格参考

本次代码更新日期：2026-11-01（America/New_York），尚未部署生产。

个人「AI 设置」、研究报告内的模型设置和项目管理「AI设置」均支持 Kimi。个人模型仍按账号加密保存，项目管理仍使用原企业配置与管理权限；添加服务商不会改变当前选用模型、覆盖已存密钥或自动发起模型调用。

## Kimi 配置

- 国内 OpenAI 兼容基础地址：`https://api.moonshot.cn/v1`；国际地址可按账号改为 `https://api.moonshot.ai/v1`。
- 服务商选择 Kimi 时预填 `kimi-k3.1-pro`，API Key 由用户在平台创建后填写；Kimi 会员 / Code 订阅不等于开放平台 API 额度。
- 官方当前列出 `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k2.6`。K2.x 自 2026-10-31 起不向新注册用户开放，计划于 2026-12 底下线；旧 `kimi-k2.5`、`moonshot-v1` 等不作为预置选项。
- K3 请求省略固定采样参数，使用 `max_completion_tokens`。连接探测采用 low 推理强度及 4,096 输出预算；正常调用 high / 16,384，工具对话也保留必需的 `reasoning_content`。不新增数据库迁移。
- 型号、价格预置不证明账号已开通该模型，需由用户主动测试连接；测试可能计费。开发回归使用模拟接口及隔离数据库，没有使用真实 Key 付费调用。

官方来源：[模型列表](https://platform.kimi.ai/docs/models)、[K3.1 指南](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)、[参数差异](https://platform.kimi.ai/docs/api/models-overview)、[国内快速开始](https://platform.kimi.com/docs/get-api-key)。

## 选择时展示价格

模型预置下拉框直接标注输入/输出单价，选中后显示价格表、币种、每百万 tokens 单位、核对日期及官方链接。研究报告和 AI 助手的个人模型选择项也带参考单价。企业默认选项没有暴露完整连接元数据，仍需在项目管理 AI 设置中查看其价格。

数据位于 `src/lib/modelPricingData.ts`，匹配与格式化位于 `src/lib/modelPricing.ts`，统一展示组件为 `ModelPricePicker`。本轮包含 45 条按地区/接口区分的型号记录，36 条有价格；数值是版本内静态快照，不是实时查询或账单估算。

- 必须同时匹配服务商、官方 HTTPS 基础地址和模型 ID。自定义、第三方代理、未知路径/端口或未知型号显示「暂无已核实价格，不代表免费」。不把官方上游价格当成转售价格。
- 人民币 CNY 与美元 USD 分别显示，不自行折算汇率；0.003 等小额价格保留足够小数，明确免费为 0，未公布显示「未公布」。
- 同一模型有上下文长度、高峰/低峰等多档时逐档列示。缓存命中与写入分列；Kimi 写入按 5 分钟/1 小时 TTL 区分，OpenAI 使用其公布的 30 分钟/12 小时档位。
- 参考价格不涵盖套餐、商议价、全部优惠、所有区域、工具调用或未列出的服务档位。实际结算以服务商账户及账单为准。

## 本次核对来源

| 服务商 | 范围与数值来源 | 官方资料 |
| --- | --- | --- |
| Kimi | 国内 K3 三个型号，人民币；本次用户提供的定价截图为数值依据，并对照官方计费说明。官方 Markdown 的动态表格为空，未臆造 K2.x 或国际美元价格 | [国内计费](https://platform.kimi.com/docs/pricing/chat)、[国际计费](https://platform.kimi.ai/docs/pricing/chat) |
| DeepSeek | Flash / V4-Pro，美元高峰与低峰；旧 Flash alias 按官方迁移规则匹配 | [官方 API 定价](https://api-docs.deepseek.com/quick_start/pricing/) |
| MiniMax | 国内/国际 M3 与 M3.1-Flash，按输入长度区分；未能在当前定价页再次核实的旧型号不预置价格 | [国内](https://platform.minimaxi.com/docs/pricing/overview)、[国际](https://platform.minimax.io/docs/pricing/overview) |
| GLM | 官方价格页列出的 23 个文本型号，人民币，按表中输入/输出长度档位 | [官方 API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing) |
| OpenAI | GPT-6 Astra、GPT-6.1 Sol / Terra、GPT-6 Luna 的 Standard 短上下文美元价；长上下文、Fast、Batch 等以官方页面为准 | [OpenAI Pricing](https://developers.openai.com/api/docs/pricing) |

Kimi 国际型号保留选择入口和官方链接，但价格明确待核实；本地 Ollama 没有预置平台 token 单价，不标成免费云模型。任意从 API 读取的未知型号同样显示待核实。

## 维护与验证

更新单价时同时核对型号、币种、基础地址、计费档位、优惠期限及来源，修改 `checkedAt`，维护模型目录和文档。对日期版本或别名仅在官方明确同价时增加匹配，不按名称前缀猜价格。新模型不得直接复用上一代单价。

回归覆盖端点/服务商隔离、币种、阶梯价、小额精度、未知价回退、选择后显示与保存、Kimi 参数、工具推理消息及旧配置兼容。现有 Key 保留、跨地址清除、预览不保存密钥等边界继续受原测试约束。
