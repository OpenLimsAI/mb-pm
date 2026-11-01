import { modelPriceCatalog } from './modelPricingData'

export interface PriceRate {
  tier: string
  input: number
  output: number
  cacheHit?: number
  cacheUnsupported?: boolean
  cacheWrites?: Record<string, number>
}
export interface ModelQuote {
  provider: string
  model: string
  aliases?: string[]
  endpoints: string[]
  currency: 'CNY' | 'USD'
  rates: PriceRate[]
  source: string
  checkedAt: string
  note?: string
}

function endpoint(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return ''
    return url.origin + url.pathname.replace(/\/+$/, '')
  } catch { return '' }
}

/** Match both the provider and exact official endpoint; never price a relay as its upstream. */
export function modelQuotes(provider: string, baseUrl: string): ModelQuote[] {
  const address = endpoint(baseUrl)
  return modelPriceCatalog.filter(quote => quote.provider === provider && quote.endpoints.includes(address))
}
export function modelQuote(provider: string, baseUrl: string, model: string): ModelQuote | undefined {
  const name = model.trim()
  return modelQuotes(provider, baseUrl).find(quote => quote.model === name || quote.aliases?.includes(name) || (provider === 'glm' && quote.model.toLowerCase() === name.toLowerCase()))
}
export function money(value: number, currency: 'CNY' | 'USD'): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 6 }).format(value)
}
export function modelPriceLabel(provider: string, baseUrl: string, model: string): string {
  const quote = modelQuote(provider, baseUrl, model)
  if (!quote?.rates.length) return `${model} · 价格待核实`
  const range = (key: 'input' | 'output') => {
    const values = quote.rates.map(rate => rate[key])
    const min = Math.min(...values), max = Math.max(...values)
    return money(min, quote.currency) + (min === max ? '' : `–${money(max, quote.currency)}`)
  }
  return `${model} · 输入 ${range('input')} / 输出 ${range('output')} · 每百万 tokens`
}
