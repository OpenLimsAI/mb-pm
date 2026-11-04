import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Project } from '../../types'
import { users, getProjectTasks, TODAY } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { can } from '../../lib/permissions'
import { managementError, pmManagement, type ChangeSummary, type CostDraft, type CostEntry, type CostSummary, type QualityItem, type RegisterDraft, type RegisterEntry } from '../../api/pmManagement'

const today = () => `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`
const money = (value: number) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 万'
const registerKinds = { risk: '风险', issue: '问题', decision: '决策' }
const costKinds = { actual: '已发生明细', payment: '待付款计划', remaining: '其他剩余估计' }
const severityLabels = { high: '高', medium: '中', low: '低' }
const person = (id: string) => users.find(user => user.id === id)?.displayName || id
const fieldLabels: Record<string, string> = { status: '状态', progress: '进度', ownerId: '负责人', collaboratorIds: '协作人', plannedStart: '计划开始', plannedEnd: '计划结束', actualStart: '实际开始', actualEnd: '实际结束', estimatedEffort: '预计工时', actualEffort: '实际工时', actualCost: '实际花费（万）', costBudget: '任务预算（万）', notes: '说明', name: '名称', title: '事项', kind: '类型', severity: '重要程度', dueDate: '期限', mitigation: '应对措施', closure: '关闭结果', amount: '金额（万）', category: '类别', occurredOn: '发生 / 计划日期', evidenceUrl: '凭据链接', taskId: '关联任务', voided: '作废', voidReason: '作废原因' }
const actionLabels: Record<string, string> = { change: '任务变更', progress: '进展记录', comment: '任务讨论', acceptance: '交付验收', deliverable: '交付物' }
function changeLines(changes: Record<string, unknown>) {
  const display = (value: unknown, field: string): string => {
    if (value === null || value === undefined || value === '') return '未填'
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (field === 'ownerId') return person(String(value))
    if (Array.isArray(value)) return value.map(item => field === 'collaboratorIds' ? person(String(item)) : String(item)).join('、') || '无'
    return String(value)
  }
  return Object.entries(changes).flatMap(([field, value]) => {
    if (!value || typeof value !== 'object') return []
    const delta = value as { before?: unknown; after?: unknown }
    return [`${fieldLabels[field] || field}：${display(delta.before, field)} → ${display(delta.after, field)}`]
  })
}
const freshRegister = (project: Project): RegisterDraft => ({ kind: 'risk', title: '', ownerId: project.ownerId, dueDate: today(), severity: 'medium', status: 'open', mitigation: '', closure: '' })
const freshCost = (): CostDraft => ({ kind: 'actual', title: '', category: '外包/CRO', amount: 0, occurredOn: today(), taskId: null, evidenceUrl: '', notes: '', voided: false, voidReason: '' })

export function PMManagement({ project }: { project: Project }) {
  const online = useDataStore(state => state.mode) === 'api'
  const role = useAuth(state => state.currentUser?.role)
  const editable = can(role, 'project.edit')
  const version = useDataStore(state => state.version)
  const [tab, setTab] = useState<'register' | 'costs' | 'quality' | 'changes'>('register')
  const [register, setRegister] = useState<RegisterEntry[]>([])
  const [costs, setCosts] = useState<CostSummary | null>(null)
  const [quality, setQuality] = useState<QualityItem[]>([])
  const [changes, setChanges] = useState<ChangeSummary | null>(null)
  const [days, setDays] = useState(7)
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [registerDraft, setRegisterDraft] = useState<RegisterDraft | null>(null)
  const [registerId, setRegisterId] = useState<string>()
  const [costDraft, setCostDraft] = useState<CostDraft | null>(null)
  const [costId, setCostId] = useState<string>()
  const team = users.filter(user => user.isActive && [project.ownerId, ...(project.memberIds || [])].includes(user.id))
  const tasks = getProjectTasks(project.id)

  useEffect(() => {
    if (!online) return
    let active = true
    void Promise.resolve().then(() => { if (active) { setLoading(true); setError('') } })
    Promise.all([pmManagement.register(project.id), pmManagement.costs(project.id), pmManagement.quality(project.id), pmManagement.changes(project.id, days)])
      .then(([r, c, q, a]) => { if (active) { setRegister(r); setCosts(c); setQuality(q.items); setChanges(a) } })
      .catch(err => { if (active) setError(managementError(err)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [project.id, online, reload, days, version])

  async function saveRegister(event: React.FormEvent) {
    event.preventDefault()
    if (!registerDraft || saving) return
    setSaving(true); setError('')
    try { await pmManagement.saveRegister(project.id, registerDraft, registerId); setRegisterDraft(null); setReload(value => value + 1) }
    catch (err) { setError(managementError(err)) } finally { setSaving(false) }
  }
  async function saveCost(event: React.FormEvent) {
    event.preventDefault()
    if (!costDraft || saving) return
    setSaving(true); setError('')
    try { await pmManagement.saveCost(project.id, costDraft, costId); setCostDraft(null); setReload(value => value + 1) }
    catch (err) { setError(managementError(err)) } finally { setSaving(false) }
  }
  function exportWeek() {
    if (!changes) return
    const text = [`# ${project.name} · 项目变更周报`, `时间：${new Date(changes.from).toLocaleString('zh-CN')} — ${new Date(changes.to).toLocaleString('zh-CN')}`, '', `实际记录 ${changes.items.length} 条变更。完成 ${changes.summary?.completed || 0} 项，新增阻塞 ${changes.summary?.blocked || 0} 项，计划延期 ${changes.summary?.delayed || 0} 项。仅使用已保存的历史记录。`, '', ...changes.items.map(item => `- ${new Date(item.createdAt).toLocaleString('zh-CN')} · ${person(item.actorId)} · ${item.title} · ${actionLabels[item.action] || item.action}\n  ${item.detail}\n  ${changeLines(item.changes).join('；')}`)].join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `${project.code}-变更周报.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  if (!online) return <div className="card p-5 text-sm text-ink-500">连接后端并登录后，可维护项目台账、费用和通知。</div>
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      {(['register', 'costs', 'quality', 'changes'] as const).map(value => <button key={value} type="button" className={`btn ${tab === value ? 'btn-primary' : ''}`} onClick={() => setTab(value)}>{{ register: '风险 / 问题 / 决策', costs: '费用与预测', quality: `数据待办 ${quality.length}`, changes: '变更与周报' }[value]}</button>)}
      <button type="button" className="btn ml-auto" onClick={() => setReload(value => value + 1)} disabled={loading}>刷新</button>
    </div>
    {error && <p role="alert" className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}。表单内容已保留。</p>}
    {loading && <p role="status" className="text-sm text-ink-500">正在读取最新记录…</p>}
    {tab === 'register' && <section className="card p-5 space-y-4">
      <div className="flex justify-between gap-3"><div><h2 className="font-semibold">项目跟进台账</h2><p className="text-xs text-ink-500 mt-1">明确负责人、措施和期限，关闭时记录处理结果。</p></div>{editable && <button className="btn btn-primary" onClick={() => { setRegisterId(undefined); setRegisterDraft(freshRegister(project)) }}>新增事项</button>}</div>
      {registerDraft && <form onSubmit={saveRegister} className="p-4 rounded-lg bg-ink-50 border space-y-3">
        <div className="grid sm:grid-cols-3 gap-3"><label className="text-sm">类型<select aria-label="事项类型" className="input" value={registerDraft.kind} onChange={event => setRegisterDraft({ ...registerDraft, kind: event.target.value as RegisterDraft['kind'] })}>{Object.entries(registerKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="text-sm">负责人<select aria-label="事项负责人" className="input" value={registerDraft.ownerId} onChange={event => setRegisterDraft({ ...registerDraft, ownerId: event.target.value })}>{team.map(user => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></label><label className="text-sm">截止日期<input aria-label="事项截止日期" className="input" type="date" required value={registerDraft.dueDate} onChange={event => setRegisterDraft({ ...registerDraft, dueDate: event.target.value })} /></label></div>
        <label className="block text-sm">事项名称<input aria-label="事项名称" required maxLength={200} className="input" value={registerDraft.title} onChange={event => setRegisterDraft({ ...registerDraft, title: event.target.value })} /></label>
        <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">重要程度<select className="input" value={registerDraft.severity} onChange={event => setRegisterDraft({ ...registerDraft, severity: event.target.value as RegisterDraft['severity'] })}>{Object.entries(severityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="text-sm">状态<select aria-label="事项状态" className="input" value={registerDraft.status} onChange={event => setRegisterDraft({ ...registerDraft, status: event.target.value as RegisterDraft['status'] })}><option value="open">跟进中</option><option value="closed">已关闭</option></select></label></div>
        <label className="block text-sm">应对措施 / 待决策内容<textarea aria-label="应对措施" className="input" maxLength={5000} value={registerDraft.mitigation} onChange={event => setRegisterDraft({ ...registerDraft, mitigation: event.target.value })} /></label>
        <label className="block text-sm">关闭条件 / 处理结果<textarea aria-label="关闭结果" className="input" maxLength={5000} required={registerDraft.status === 'closed'} value={registerDraft.closure} onChange={event => setRegisterDraft({ ...registerDraft, closure: event.target.value })} /></label>
        <div className="flex gap-2"><button className="btn btn-primary" disabled={saving}>保存事项</button><button type="button" className="btn" disabled={saving} onClick={() => setRegisterDraft(null)}>取消</button></div>
      </form>}
      {register.length === 0 && !loading && <p className="text-sm text-ink-500">暂无跟进事项。</p>}
      {register.map(entry => <article key={entry.id} className="border rounded-lg p-3 text-sm space-y-2"><div className="flex flex-wrap items-center gap-2"><span className="text-xs rounded bg-ink-100 px-2 py-1">{registerKinds[entry.kind]} · {severityLabels[entry.severity]}</span><strong className="flex-1 min-w-0 break-words">{entry.title}</strong><span>{entry.status === 'closed' ? '已关闭' : '跟进中'}</span>{editable && <button className="btn" onClick={() => { setRegisterId(entry.id); setRegisterDraft({ ...entry, expectedRevision: entry.revision }) }}>编辑</button>}</div><p className={entry.status === 'open' && entry.dueDate < today() ? 'text-red-700' : 'text-ink-500'}>{person(entry.ownerId)} · 截止 {entry.dueDate}</p>{entry.mitigation && <p className="whitespace-pre-wrap">措施：{entry.mitigation}</p>}{entry.closure && <p className="whitespace-pre-wrap">关闭条件 / 结果：{entry.closure}</p>}</article>)}
    </section>}
    {tab === 'costs' && <section className="card p-5 space-y-4">
      <div className="flex justify-between gap-3"><div><h2 className="font-semibold">费用明细与完工预测</h2><p className="text-xs text-ink-500 mt-1">金额单位：万元。已发生明细用于对账，实际花费沿用任务累计数。</p></div>{editable && <button className="btn btn-primary" onClick={() => { setCostId(undefined); setCostDraft(freshCost()) }}>新增费用</button>}</div>
      {costs && <><div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[['任务实际花费', costs.spent], ['待付款计划', costs.payments], ['其他剩余估计', costs.remaining], ['预测完工成本', costs.forecast]].map(([label, value]) => <div key={String(label)} className="bg-ink-50 p-3 rounded-lg"><p className="text-xs text-ink-500">{label}</p><strong>{money(Number(value))}</strong></div>)}</div><p className="text-xs text-ink-500">已发生明细 {money(costs.recordedActual)}；与任务累计数差额 {money(costs.unreconciled)}。预测 = 任务实际花费 + 待付款 + 其他剩余估计。付款后请将对应计划改为已发生，并在任务进展中更新累计花费。</p>{costs.budget !== null && Number(costs.forecast) > Number(costs.budget) && <p role="status" className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">预测成本超出项目预算 {money(Number(costs.forecast) - Number(costs.budget))}。</p>}</>}
      {costDraft && <form onSubmit={saveCost} className="p-4 border bg-ink-50 rounded-lg space-y-3">
        <div className="grid sm:grid-cols-3 gap-3"><label className="text-sm">类型<select aria-label="费用类型" className="input" value={costDraft.kind} onChange={event => setCostDraft({ ...costDraft, kind: event.target.value as CostDraft['kind'] })}>{Object.entries(costKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="text-sm">金额（万元）<input aria-label="费用金额" required type="number" min="0.01" max="9999999999" step="0.01" className="input" value={costDraft.amount || ''} onChange={event => setCostDraft({ ...costDraft, amount: Number(event.target.value) })} /></label><label className="text-sm">发生 / 计划日期<input aria-label="费用日期" required type="date" className="input" value={costDraft.occurredOn} onChange={event => setCostDraft({ ...costDraft, occurredOn: event.target.value })} /></label></div>
        <label className="block text-sm">费用名称<input aria-label="费用名称" required maxLength={200} className="input" value={costDraft.title} onChange={event => setCostDraft({ ...costDraft, title: event.target.value })} /></label>
        <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">类别<input aria-label="费用类别" required maxLength={40} className="input" value={costDraft.category} onChange={event => setCostDraft({ ...costDraft, category: event.target.value })} /></label><label className="text-sm">关联任务<select aria-label="费用关联任务" className="input" value={costDraft.taskId || ''} onChange={event => setCostDraft({ ...costDraft, taskId: event.target.value || null })}><option value="">项目级费用</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label></div>
        <label className="block text-sm">合同 / 凭据链接<input aria-label="费用凭据链接" type="url" maxLength={2000} className="input" value={costDraft.evidenceUrl} onChange={event => setCostDraft({ ...costDraft, evidenceUrl: event.target.value })} /></label>
        <label className="block text-sm">说明<textarea aria-label="费用说明" maxLength={5000} className="input" value={costDraft.notes} onChange={event => setCostDraft({ ...costDraft, notes: event.target.value })} /></label>
        {costId && <div className="space-y-2"><label className="flex items-center gap-2 text-sm"><input aria-label="作废费用明细" type="checkbox" checked={costDraft.voided} onChange={event => setCostDraft({ ...costDraft, voided: event.target.checked })} />作废此条目（保留历史，排除汇总）</label>{costDraft.voided && <label className="block text-sm">作废原因<textarea aria-label="费用作废原因" required maxLength={2000} className="input" value={costDraft.voidReason} onChange={event => setCostDraft({ ...costDraft, voidReason: event.target.value })} /></label>}</div>}
        <div className="flex gap-2"><button className="btn btn-primary" disabled={saving}>保存费用</button><button type="button" className="btn" disabled={saving} onClick={() => setCostDraft(null)}>取消</button></div>
      </form>}
      {costs?.items.length === 0 && !loading && <p className="text-sm text-ink-500">暂无费用明细。</p>}
      {costs?.items.map(entry => <CostRow key={entry.id} entry={entry} editable={editable} onEdit={() => { setCostId(entry.id); setCostDraft({ ...entry, amount: Number(entry.amount), expectedRevision: entry.revision }) }} />)}
    </section>}
    {tab === 'quality' && <section className="card p-5 space-y-3"><h2 className="font-semibold">数据质量待办</h2><p className="text-xs text-ink-500">按当前可见任务实时检查；补齐信息后刷新，已解决事项自动移出。</p>{quality.length === 0 && !loading && <p className="text-sm text-emerald-700">当前检查项均已补齐。</p>}{quality.map(item => <Link key={item.id} to={item.url} className="block p-3 rounded border hover:bg-brand-50 text-sm"><strong>{item.title}</strong><p className="mt-1 text-amber-800">{item.reason}</p><span className="text-xs text-ink-500">{person(item.ownerId)} · 打开任务处理 →</span></Link>)}</section>}
    {tab === 'changes' && <section className="card p-5 space-y-3"><div className="flex flex-wrap gap-3 items-center"><h2 className="font-semibold flex-1">真实变更与周报</h2><select aria-label="变更时间范围" className="input !w-auto" value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select><button className="btn" disabled={!changes} onClick={exportWeek}>导出周报</button></div>{changes?.summary && <div className="grid grid-cols-3 gap-3">{[['本期完成', changes.summary.completed], ['新增阻塞', changes.summary.blocked], ['计划延期', changes.summary.delayed]].map(([label, count]) => <div key={String(label)} className="rounded bg-ink-50 p-3 text-sm"><p className="text-xs text-ink-500">{label}</p><strong>{count} 项</strong></div>)}</div>}<p className="text-xs text-ink-500">展示实际保存的变更、进展、讨论和验收记录，最多 1,000 条。历史记录从功能启用后逐步积累。</p>{changes?.items.length === 0 && !loading && <p className="text-sm text-ink-500">所选时间范围内暂无变更记录。</p>}{changes?.items.map(item => <article key={item.id} className="border rounded p-3 text-sm"><div className="text-xs text-ink-500">{new Date(item.createdAt).toLocaleString('zh-CN')} · {person(item.actorId)} · {actionLabels[item.action] || item.action}</div>{item.taskId ? <Link className="font-medium text-brand-700" to={`/projects/${project.id}?tab=wbs&task=${encodeURIComponent(item.taskId)}`}>{item.title}</Link> : <strong>{item.title}</strong>}<p className="whitespace-pre-wrap break-words mt-1">{item.detail}</p>{Object.keys(item.changes).length > 0 && <div className="text-xs space-y-1 break-words bg-ink-50 rounded p-2 mt-2">{changeLines(item.changes).map(line => <p key={line}>{line}</p>)}</div>}</article>)}</section>}
  </div>
}
function CostRow({ entry, editable, onEdit }: { entry: CostEntry; editable: boolean; onEdit: () => void }) {
  return <article className="border rounded-lg p-3 text-sm space-y-1"><div className="flex gap-3 items-center"><span className="text-xs bg-ink-100 rounded px-2 py-1">{costKinds[entry.kind]}{entry.voided ? " · 已作废" : ""}</span><strong className="flex-1 min-w-0 break-words">{entry.title}</strong><span className="font-medium">{money(entry.amount)}</span>{editable && <button className="btn" onClick={onEdit}>编辑</button>}</div><p className="text-xs text-ink-500">{entry.occurredOn} · {entry.category}</p>{entry.voided && <p className="text-red-700">作废原因：{entry.voidReason}</p>}{entry.notes && <p className="whitespace-pre-wrap">{entry.notes}</p>}{entry.evidenceUrl && <a className="text-brand-700 underline" href={entry.evidenceUrl} target="_blank" rel="noopener noreferrer">打开合同 / 凭据</a>}</article>
}
