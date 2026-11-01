import type { ModelQuote } from './modelPricing'

// Official price snapshots; maintenance rules and provenance: docs/model-pricing.md.
export const modelPriceCatalog: readonly ModelQuote[] = [
  {
    "provider": "kimi",
    "model": "kimi-k3.1-pro",
    "endpoints": [
      "https://api.moonshot.cn/v1"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "标准按量",
        "input": 13,
        "output": 68,
        "cacheHit": 1.3,
        "cacheWrites": {
          "5分钟": 13,
          "1小时": 26
        }
      }
    ],
    "source": "https://platform.kimi.com/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "缓存写入按 TTL 额外计费；缓存命中不重复收取写入费用。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k3.1-pro-highspeed",
    "endpoints": [
      "https://api.moonshot.cn/v1"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "标准按量",
        "input": 26,
        "output": 136,
        "cacheHit": 1.3,
        "cacheWrites": {
          "5分钟": 26,
          "1小时": 52
        }
      }
    ],
    "source": "https://platform.kimi.com/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "缓存写入按 TTL 额外计费；缓存命中不重复收取写入费用。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k3",
    "endpoints": [
      "https://api.moonshot.cn/v1"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "标准按量",
        "input": 20,
        "output": 100,
        "cacheHit": 2,
        "cacheWrites": {
          "5分钟": 20,
          "1小时": 40
        }
      }
    ],
    "source": "https://platform.kimi.com/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "缓存写入按 TTL 额外计费；缓存命中不重复收取写入费用。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k2.7-code",
    "endpoints": [
      "https://api.moonshot.cn/v1"
    ],
    "currency": "CNY",
    "rates": [],
    "source": "https://platform.kimi.com/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "仅老账号可用；自 2026-10-31 起不向新用户开放，计划于 2026-12 底下线。当前价格请查官方页面。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k2.7-code-highspeed",
    "endpoints": [
      "https://api.moonshot.cn/v1"
    ],
    "currency": "CNY",
    "rates": [],
    "source": "https://platform.kimi.com/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "仅老账号可用；自 2026-10-31 起不向新用户开放，计划于 2026-12 底下线。当前价格请查官方页面。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k2.6",
    "endpoints": [
      "https://api.moonshot.cn/v1"
    ],
    "currency": "CNY",
    "rates": [],
    "source": "https://platform.kimi.com/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "仅老账号可用；自 2026-10-31 起不向新用户开放，计划于 2026-12 底下线。当前价格请查官方页面。"
  },
  {
    "provider": "deepseek",
    "model": "deepseek-flash",
    "endpoints": [
      "https://api.deepseek.com",
      "https://api.deepseek.com/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "低峰",
        "input": 0.15,
        "output": 0.6,
        "cacheHit": 0.003
      },
      {
        "tier": "高峰",
        "input": 0.3,
        "output": 1.2,
        "cacheHit": 0.006
      }
    ],
    "source": "https://api-docs.deepseek.com/quick_start/pricing/",
    "checkedAt": "2026-11-01",
    "note": "高峰、低峰时段按官方规则判定。",
    "aliases": [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp"
    ]
  },
  {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
    "endpoints": [
      "https://api.deepseek.com",
      "https://api.deepseek.com/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "低峰",
        "input": 0.66,
        "output": 1.98,
        "cacheHit": 0.022
      },
      {
        "tier": "高峰",
        "input": 1.32,
        "output": 3.96,
        "cacheHit": 0.044
      }
    ],
    "source": "https://api-docs.deepseek.com/quick_start/pricing/",
    "checkedAt": "2026-11-01",
    "note": "高峰、低峰时段按官方规则判定。"
  },
  {
    "provider": "minimax",
    "model": "MiniMax-M3",
    "endpoints": [
      "https://api.minimaxi.com/v1"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "标准 · 输入 ≤512K",
        "input": 2.1,
        "output": 8.4,
        "cacheHit": 0.42
      },
      {
        "tier": "标准 · 输入 >512K",
        "input": 4.2,
        "output": 16.8,
        "cacheHit": 0.84
      }
    ],
    "source": "https://platform.minimaxi.com/docs/pricing/overview",
    "checkedAt": "2026-11-01",
    "note": "按当前官网优惠价列示；Priority 档另按标准价 1.5 倍计费。"
  },
  {
    "provider": "minimax",
    "model": "MiniMax-M3.1-Flash",
    "endpoints": [
      "https://api.minimaxi.com/v1"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "标准",
        "input": 1,
        "output": 4,
        "cacheHit": 0.1
      }
    ],
    "source": "https://platform.minimaxi.com/docs/pricing/overview",
    "checkedAt": "2026-11-01"
  },
  {
    "provider": "minimax",
    "model": "MiniMax-M3",
    "endpoints": [
      "https://api.minimax.io/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "标准 · 输入 ≤512K",
        "input": 0.3,
        "output": 1.2,
        "cacheHit": 0.06
      },
      {
        "tier": "标准 · 输入 >512K",
        "input": 0.6,
        "output": 2.4,
        "cacheHit": 0.12
      }
    ],
    "source": "https://platform.minimax.io/docs/pricing/overview",
    "checkedAt": "2026-11-01",
    "note": "按当前官网优惠价列示；Priority 档另按标准价 1.5 倍计费。"
  },
  {
    "provider": "minimax",
    "model": "MiniMax-M3.1-Flash",
    "endpoints": [
      "https://api.minimax.io/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "标准",
        "input": 0.15,
        "output": 0.6,
        "cacheHit": 0.015
      }
    ],
    "source": "https://platform.minimax.io/docs/pricing/overview",
    "checkedAt": "2026-11-01"
  },
  {
    "provider": "openai",
    "model": "gpt-6-astra",
    "endpoints": [
      "https://api.openai.com/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "Standard · 短上下文",
        "input": 10,
        "output": 50,
        "cacheHit": 1,
        "cacheWrites": {
          "30分钟": 12.5,
          "12小时": 25.0
        }
      }
    ],
    "source": "https://developers.openai.com/api/docs/pricing",
    "checkedAt": "2026-11-01",
    "note": "此处列标准短上下文价格；长上下文、Fast、Batch 和特殊区域另计。"
  },
  {
    "provider": "openai",
    "model": "gpt-6.1-sol",
    "endpoints": [
      "https://api.openai.com/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "Standard · 短上下文",
        "input": 2,
        "output": 10,
        "cacheHit": 0.1,
        "cacheWrites": {
          "30分钟": 2.5,
          "12小时": 5.0
        }
      }
    ],
    "source": "https://developers.openai.com/api/docs/pricing",
    "checkedAt": "2026-11-01",
    "note": "此处列标准短上下文价格；长上下文、Fast、Batch 和特殊区域另计。"
  },
  {
    "provider": "openai",
    "model": "gpt-6.1-terra",
    "endpoints": [
      "https://api.openai.com/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "Standard · 短上下文",
        "input": 1,
        "output": 5,
        "cacheHit": 0.05,
        "cacheWrites": {
          "30分钟": 1.25,
          "12小时": 2.5
        }
      }
    ],
    "source": "https://developers.openai.com/api/docs/pricing",
    "checkedAt": "2026-11-01",
    "note": "此处列标准短上下文价格；长上下文、Fast、Batch 和特殊区域另计。"
  },
  {
    "provider": "openai",
    "model": "gpt-6-luna",
    "endpoints": [
      "https://api.openai.com/v1"
    ],
    "currency": "USD",
    "rates": [
      {
        "tier": "Standard · 短上下文",
        "input": 0.1,
        "output": 0.5,
        "cacheHit": 0.01,
        "cacheWrites": {
          "30分钟": 0.125,
          "12小时": 0.25
        }
      }
    ],
    "source": "https://developers.openai.com/api/docs/pricing",
    "checkedAt": "2026-11-01",
    "note": "此处列标准短上下文价格；长上下文、Fast、Batch 和特殊区域另计。"
  },
  {
    "provider": "glm",
    "model": "glm-5.3",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "1M",
        "input": 8.0,
        "output": 28.0,
        "cacheHit": 2.0
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-5.3-flash",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "1M",
        "input": 0.8,
        "output": 2.8,
        "cacheHit": 0.23
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-5.3-flashx",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "1M",
        "input": 2.0,
        "output": 7.0,
        "cacheHit": 0.57
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-5.3-flashx-legal",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "1M",
        "input": 2.0,
        "output": 7.0,
        "cacheHit": 0.57
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-5.2",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "1M",
        "input": 8.0,
        "output": 28.0,
        "cacheHit": 2.0
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-5.1",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "输入长度 [0, 32K)",
        "input": 6.0,
        "output": 24.0,
        "cacheHit": 1.3
      },
      {
        "tier": "输入长度 ≥32K",
        "input": 8.0,
        "output": 28.0,
        "cacheHit": 2.0
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-5-turbo",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "输入长度 [0, 32K)",
        "input": 5.0,
        "output": 22.0,
        "cacheHit": 1.2
      },
      {
        "tier": "输入长度 ≥32K",
        "input": 7.0,
        "output": 26.0,
        "cacheHit": 1.8
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-5",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "输入长度 [0, 32K)",
        "input": 4.0,
        "output": 18.0,
        "cacheHit": 1.0
      },
      {
        "tier": "输入长度 ≥32K",
        "input": 6.0,
        "output": 22.0,
        "cacheHit": 1.5
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4.7",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "输入 [0, 32K)，输出 [0, 0.2K)",
        "input": 2.0,
        "output": 8.0,
        "cacheHit": 0.4
      },
      {
        "tier": "输入 [0, 32K)，输出 ≥0.2K",
        "input": 3.0,
        "output": 14.0,
        "cacheHit": 0.6
      },
      {
        "tier": "输入 [32K, 200K)",
        "input": 4.0,
        "output": 16.0,
        "cacheHit": 0.8
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4.5-air",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "输入 [0, 32K)，输出 [0, 0.2K)",
        "input": 0.8,
        "output": 2.0,
        "cacheHit": 0.16
      },
      {
        "tier": "输入 [0, 32K)，输出 ≥0.2K",
        "input": 0.8,
        "output": 6.0,
        "cacheHit": 0.16
      },
      {
        "tier": "输入 [32K, 128K)",
        "input": 1.2,
        "output": 8.0,
        "cacheHit": 0.24
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4.7-flashx",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "200K",
        "input": 0.5,
        "output": 3.0,
        "cacheHit": 0.1
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4.7-flash",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "200K",
        "input": 0,
        "output": 0,
        "cacheHit": 0
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4-plus",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 5.0,
        "output": 5.0,
        "cacheHit": 2.5
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4-air-250414",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 0.5,
        "output": 0.5,
        "cacheHit": 0.25
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4-airx",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "8K",
        "input": 10.0,
        "output": 10.0,
        "cacheUnsupported": true
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4-long",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "1M",
        "input": 1.0,
        "output": 1.0,
        "cacheHit": 0.5
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4-assistant",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 5.0,
        "output": 5.0,
        "cacheUnsupported": true
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-z1-air",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 0.5,
        "output": 0.5,
        "cacheUnsupported": true
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-z1-airx",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "32K",
        "input": 5.0,
        "output": 5.0,
        "cacheUnsupported": true
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-z1-flashx",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 0.1,
        "output": 0.1,
        "cacheUnsupported": true
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4-flashx-250414",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 0.1,
        "output": 0.1,
        "cacheHit": 0.05
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-4-flash-250414",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 0,
        "output": 0,
        "cacheUnsupported": true
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "glm",
    "model": "glm-z1-flash",
    "endpoints": [
      "https://open.bigmodel.cn/api/paas/v4"
    ],
    "currency": "CNY",
    "rates": [
      {
        "tier": "128K",
        "input": 0,
        "output": 0,
        "cacheUnsupported": true
      }
    ],
    "source": "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "checkedAt": "2026-11-01",
    "note": "缓存存储当前限时免费；按表中输入/输出长度档位计费。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k3.1-pro",
    "endpoints": [
      "https://api.moonshot.ai/v1"
    ],
    "currency": "USD",
    "rates": [],
    "source": "https://platform.kimi.ai/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "国际站美元价格尚未核实，请查官方价格。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k3.1-pro-highspeed",
    "endpoints": [
      "https://api.moonshot.ai/v1"
    ],
    "currency": "USD",
    "rates": [],
    "source": "https://platform.kimi.ai/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "国际站美元价格尚未核实，请查官方价格。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k3",
    "endpoints": [
      "https://api.moonshot.ai/v1"
    ],
    "currency": "USD",
    "rates": [],
    "source": "https://platform.kimi.ai/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "国际站美元价格尚未核实，请查官方价格。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k2.7-code",
    "endpoints": [
      "https://api.moonshot.ai/v1"
    ],
    "currency": "USD",
    "rates": [],
    "source": "https://platform.kimi.ai/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "国际站美元价格尚未核实，请查官方价格。 仅老账号可用；自 2026-10-31 起不向新用户开放，计划于 2026-12 底下线。当前价格请查官方页面。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k2.7-code-highspeed",
    "endpoints": [
      "https://api.moonshot.ai/v1"
    ],
    "currency": "USD",
    "rates": [],
    "source": "https://platform.kimi.ai/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "国际站美元价格尚未核实，请查官方价格。 仅老账号可用；自 2026-10-31 起不向新用户开放，计划于 2026-12 底下线。当前价格请查官方页面。"
  },
  {
    "provider": "kimi",
    "model": "kimi-k2.6",
    "endpoints": [
      "https://api.moonshot.ai/v1"
    ],
    "currency": "USD",
    "rates": [],
    "source": "https://platform.kimi.ai/docs/pricing/chat",
    "checkedAt": "2026-11-01",
    "note": "国际站美元价格尚未核实，请查官方价格。 仅老账号可用；自 2026-10-31 起不向新用户开放，计划于 2026-12 底下线。当前价格请查官方页面。"
  }
]
