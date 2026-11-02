import { useEffect, useState } from 'react'
import { Activity, Copy, RefreshCw, Save } from 'lucide-react'
import { assistantOperationsApi, operationsDenied, operationsError, type AssistantLimits, type AssistantOperations } from './assistantOperations'
import './assistantOperations.css'

const statusLabels: Record<string, string> = { queued: '排队中', running: '生成中', completed: '已完成', failed: '未完成', cancelled: '已停止' }
const errorLabels: Record<string, string> = {
  model_timeout: '模型超时', output_limit: '回答达到输出上限', response_too_large: '回复超过接收容量', model_network: '模型连接中断', model_auth: '模型密钥或权限不可用', model_rate_limit: '模型限流或额度不足', model_rejected: '模型拒绝请求', model_invalid_response: '模型返回格式异常', model_empty_response: '模型未返回正文', request_interrupted: '服务中断', permission_denied: '数据权限变化', web_timeout: '搜索超时', web_not_configured: '搜索未配置', web_auth: '搜索认证失败', web_rate_limit: '搜索限流', web_balance: '搜索余额不足', request_cancelled: '用户停止', cancelled: '用户停止',
}
const duration = (seconds: number | null | undefined) => seconds == null ? '—' : seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`

export default function AssistantOperationsPanel({ client = assistantOperationsApi }: { client?: typeof assistantOperationsApi }) {
  const [data, setData] = useState<AssistantOperations | null>(null)
  const [limits, setLimits] = useState<AssistantLimits | null>(null)
  const [hidden, setHidden] = useState(false)
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('')
  const [confirmPrune, setConfirmPrune] = useState(false)
  useEffect(() => {
    let active = true
    client.get(filter).then(value => { if (active) { setData(value); setLimits(value.limits); setHidden(false); setError('') } }).catch(reason => {
      if (!active) return
      if (operationsDenied(reason)) { setHidden(true); setData(null); setLimits(null) }
      else setError(operationsError(reason))
    })
    return () => { active = false }
  }, [client, filter, revision])
  if (hidden) return null
  async function save() {
    if (!limits) return
    if (limits.perUserRunning > limits.perUserPending) { setError('每人同时生成上限不能超过待处理上限。'); return }
    if (limits.retentionDays > 0 && limits.retentionDays < 7) { setError('启用清理时，保留期至少为 7 天。'); return }
    setBusy('save'); setError(''); setNotice('')
    try { await client.save(limits); setNotice('运行设置已保存，后续提交和调度使用新设置。'); setRevision(value => value + 1) }
    catch (reason) { if (operationsDenied(reason)) { setHidden(true); setData(null) } else setError(operationsError(reason)) }
    finally { setBusy('') }
  }
  async function prune() {
    setBusy('prune'); setError(''); setNotice('')
    try { const result = await client.prune(); setNotice(`已清理 ${result.pruned} 条过期请求的重复内容，任务与正式回答仍保留。`); setConfirmPrune(false); setRevision(value => value + 1) }
    catch (reason) { if (operationsDenied(reason)) { setHidden(true); setData(null) } else setError(operationsError(reason)) }
    finally { setBusy('') }
  }
  async function copyDiagnostic(requestId: string, diagnosticId: string, code: string) {
    try { await navigator.clipboard.writeText(`请求编号：${requestId}\n诊断编号：${diagnosticId || '尚未生成'}\n错误类型：${code || '无'}`); setNotice('诊断信息已复制，可交给管理员排查。') }
    catch { setError('复制失败，请手动选择编号复制。') }
  }
  return <section className="portal-panel assistant-operations" aria-label="助手运行管理">
    <div className="ao-heading"><div><h2><Activity size={19} />助手运行管理</h2><p>查看最近 {data?.windowHours || 24} 小时的请求状态。这里不展示问题、回答、附件或模型密钥。</p></div><button type="button" disabled={!!busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />刷新状态</button></div>
    {error && <p role="alert" className="ao-error">{error}</p>}
    {notice && <p role="status" className="ao-notice">{notice}</p>}
    {!data && !error && <p role="status">正在读取运行状态…</p>}
    {data && <>
      <div className="ao-totals">{Object.entries(statusLabels).map(([key, label]) => <div key={key}><span>{label}</span><strong>{data.totals[key] || 0}</strong></div>)}</div>
      {Object.keys(data.failureCounts).length > 0 && <div className="ao-failures" aria-label="失败原因统计">{Object.entries(data.failureCounts).map(([code, count]) => <span key={code}>{errorLabels[code] || '其他失败'}：{count}</span>)}</div>}
      <form className="ao-filter" onSubmit={event => { event.preventDefault(); if (query && !/^[a-f0-9]{32}$/i.test(query.trim())) { setError('请输入完整的 32 位诊断编号。'); return } setError(''); setFilter(query.trim().toLowerCase()); setRevision(value => value + 1) }}><label>按诊断编号查找<input value={query} maxLength={32} placeholder="粘贴错误提示中的诊断编号" onChange={event => setQuery(event.target.value)} /></label><button type="submit">查找</button>{filter && <button type="button" onClick={() => { setQuery(''); setFilter('') }}>查看全部</button>}</form>
      <div className="ao-table-wrap"><table><caption>最近请求 · 最多显示 50 条</caption><thead><tr><th>提交时间</th><th>状态 / 原因</th><th>处理时长</th><th>首段等待</th><th>诊断信息</th></tr></thead><tbody>{data.recent.map(row => <tr key={`${row.requestId}:${row.createdAt}`}><td>{new Date(row.createdAt).toLocaleString('zh-CN')}</td><td><strong>{statusLabels[row.status] || row.status}</strong>{row.errorCode && <small>{errorLabels[row.errorCode] || row.errorCode}</small>}</td><td>{duration(row.elapsedSeconds)}</td><td>{duration(row.firstContentSeconds)}</td><td><code>{row.diagnosticId || '尚未生成'}</code><button type="button" aria-label={`复制诊断信息 ${row.diagnosticId || row.requestId}`} onClick={() => void copyDiagnostic(row.requestId, row.diagnosticId, row.errorCode)}><Copy size={14} />复制</button></td></tr>)}</tbody></table>{data.recent.length === 0 && <p className="ao-empty">{filter ? '未找到对应请求，请核对编号或记录保留范围。' : '最近没有请求记录。'}</p>}</div>
      {data.canManage && limits && <details className="ao-settings"><summary>队列与记录保留设置</summary><p>限制每位用户占用的处理名额，减少长任务对其他人的影响。降低上限不会终止正在生成的回答。</p><form onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={!!busy}><div className="ao-limit-fields">
        <label>每人等待及生成中的问题上限<input type="number" min="1" max="20" required value={limits.perUserPending} onChange={event => setLimits({ ...limits, perUserPending: Number(event.target.value) })} /></label>
        <label>每人同时生成上限<input type="number" min="1" max="4" required value={limits.perUserRunning} onChange={event => setLimits({ ...limits, perUserRunning: Number(event.target.value) })} /></label>
        <label>全系统排队上限<input type="number" min="1" max="1000" required value={limits.globalQueued} onChange={event => setLimits({ ...limits, globalQueued: Number(event.target.value) })} /></label>
        <label>请求重复内容保留天数<input type="number" min="0" max="365" required value={limits.retentionDays} onChange={event => setLimits({ ...limits, retentionDays: Number(event.target.value) })} /><small>0 表示不清理；启用时至少 7 天。</small></label>
      </div><button type="submit"><Save size={15} />保存运行设置</button></fieldset></form>
      <p>清理只移除已结束请求中重复保存的输入和未完成稿，保留诊断编号、请求状态、任务及正式问答。清理后的未完成稿无法继续生成。</p>
      {!confirmPrune ? <button type="button" disabled={!!busy || !data.limits.retentionDays} onClick={() => setConfirmPrune(true)}>清理过期请求内容</button> : <div className="ao-confirm"><p>将清理已结束超过 {data.limits.retentionDays} 天的请求内容，此操作不可撤回。</p><button type="button" disabled={!!busy} onClick={() => void prune()}>确认清理</button><button type="button" disabled={!!busy} onClick={() => setConfirmPrune(false)}>取消</button></div>}
      </details>}
    </>}
  </section>
}
