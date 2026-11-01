import { modelPriceLabel, modelQuote, modelQuotes, money } from '../../lib/modelPricing'
import './modelPricing.css'

interface Props { provider: string; baseUrl: string; model: string; onSelect: (model: string) => void }

export function ModelPricePicker({ provider, baseUrl, model, onSelect }: Props) {
  const quotes = modelQuotes(provider, baseUrl)
  const quote = modelQuote(provider, baseUrl, model)
  const ttls = [...new Set(quote?.rates.flatMap(rate => Object.keys(rate.cacheWrites || {})))]
  return <div className="model-price-picker">
    {quotes.length > 0 && <label className="model-price-preset">预置模型与参考价
      <select aria-label="预置模型与参考价" value={quotes.some(item => item.model === model) ? model : ''} onChange={event => onSelect(event.target.value)}>
        <option value="" disabled>选择预置型号，或在模型名称中手动填写</option>
        {quotes.map(item => <option key={item.model} value={item.model}>{modelPriceLabel(provider, baseUrl, item.model)}{item.note?.includes('老账号') ? ' · 仅老账号' : ''}</option>)}
      </select>
    </label>}
    <section className="model-price-info" aria-label="模型参考价格" aria-live="polite">
      {quote?.rates.length ? <>
        <div className="model-price-title"><strong>{quote.model}</strong><span>{quote.currency === 'CNY' ? '人民币 CNY' : '美元 USD'} / 百万 tokens</span></div>
        <div className="model-price-scroll"><table>
          <caption>1 MTok = 1,000,000 tokens；输入列为未命中缓存单价</caption>
          <thead><tr><th scope="col">适用档位</th><th scope="col">输入</th><th scope="col">输出</th><th scope="col">缓存命中</th>{ttls.map(ttl => <th scope="col" key={ttl}>缓存写入（{ttl}）</th>)}</tr></thead>
          <tbody>{quote.rates.map(rate => <tr key={rate.tier}><th scope="row">{rate.tier}</th><td>{money(rate.input, quote.currency)}</td><td>{money(rate.output, quote.currency)}</td><td>{rate.cacheHit === undefined ? rate.cacheUnsupported ? '不支持' : '未公布' : money(rate.cacheHit, quote.currency)}</td>{ttls.map(ttl => <td key={ttl}>{rate.cacheWrites?.[ttl] === undefined ? '未公布' : money(rate.cacheWrites[ttl], quote.currency)}</td>)}</tr>)}</tbody>
        </table></div>
      </> : <p>{model ? '当前型号或服务地址暂无已核实价格，不代表免费。' : '选择或填写模型后查看参考价格。'}</p>}
      {quote?.note && <p>{quote.note}</p>}
      {quote && <p className="model-price-source">核对日期：{quote.checkedAt} · <a href={quote.source} target="_blank" rel="noopener noreferrer">官方定价</a></p>}
      <p className="model-price-disclaimer">预置参考价，非实时账单；实际按服务商、账号、计费档位与用量结算。模型是否开通请以账号权限及连接测试为准。</p>
    </section>
  </div>
}
