import { describe, expect, it } from 'vitest'
import { modelPriceLabel, modelQuote, modelQuotes, money } from './modelPricing'

describe('official model price snapshots', () => {
  it('shows the supplied Kimi mainland rates and separate cache write TTLs', () => {
    const quote = modelQuote('kimi', 'https://api.moonshot.cn/v1/', 'kimi-k3.1-pro')!
    expect(quote.currency).toBe('CNY')
    expect(quote.rates).toEqual([{ tier: '标准按量', input: 13, output: 68, cacheHit: 1.3, cacheWrites: { '5分钟': 13, '1小时': 26 } }])
    expect(modelQuotes('kimi', 'https://api.moonshot.cn/v1')).toHaveLength(6)
  })
  it('does not assign official prices to a relay, other port, path or custom provider', () => {
    for (const url of ['https://relay.example/v1', 'https://api.moonshot.cn.evil/v1', 'https://api.moonshot.cn:444/v1', 'https://api.moonshot.cn/v1/other']) {
      expect(modelQuote('kimi', url, 'kimi-k3.1-pro')).toBeUndefined()
    }
    expect(modelQuote('custom', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro')).toBeUndefined()
    expect(modelQuote('kimi', 'https://api.moonshot.ai/v1', 'kimi-k3.1-pro')?.rates).toEqual([])
  })
  it('keeps regional currencies, tiered pricing, and small nonzero rates', () => {
    expect(modelQuote('minimax', 'https://api.minimaxi.com/v1', 'MiniMax-M3')?.currency).toBe('CNY')
    expect(modelQuote('minimax', 'https://api.minimax.io/v1', 'MiniMax-M3')?.currency).toBe('USD')
    expect(modelQuote('glm', 'https://open.bigmodel.cn/api/paas/v4', 'GLM-5.1')?.rates).toHaveLength(2)
    expect(modelQuote('deepseek', 'https://api.deepseek.com', 'deepseek-v4-flash')?.model).toBe('deepseek-flash')
    expect(money(.003, 'USD')).toContain('0.003')
    expect(modelPriceLabel('deepseek', 'https://api.deepseek.com', 'unknown')).toContain('价格待核实')
    expect(modelPriceLabel('kimi', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro')).toContain('每百万 tokens')
  })
})
