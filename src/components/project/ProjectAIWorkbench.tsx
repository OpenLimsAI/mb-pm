import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { Download, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { getAIStatus, MAX_PROMPT_LENGTH, providerLabel, type AIAnalysis, type AIStatus } from '../../api/ai'
import { cancelProjectAnalysis, getProjectAnalysis, listAnalysisJobs, searchProjectAnalyses, startProjectAnalysis, type AnalysisJob } from '../../api/projectAIWork'
import { asAPIError } from '../../api/client'
import { findProject } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { useColumnWidth } from '../../lib/useColumnWidth'
import { ColumnResizer } from '../ui/ColumnResizer'
import { Button } from '../ui'
import SafeMarkdown from '../SafeMarkdown'
import { AIReportActions } from './AIReportActions'

const stateNames = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消' }
const time = (value: string) => new Date(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z').toLocaleString('zh-CN')

export function ProjectAIWorkbench({ projectId, projectName }: { projectId: string; projectName: string }) {
  const online = useDataStore(s => s.mode) === 'api'
  const me = useAuth(s => s.currentUser)
  const canStart = me?.role === 'admin' || me?.role === 'cmc_lead' || (me?.role === 'project_lead' && findProject(projectId)?.ownerId === me.id)
  const container = useRef<HTMLDivElement>(null)
  const column = useColumnWidth({ storageKey: `mb-pm:analysis-history-width:${me?.id}`, defaultWidth: 240, minWidth: 180, maxWidth: 480, reserveWidth: 420, containerRef: container })
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [focus, setFocus] = useState('')
  const [jobs, setJobs] = useState<AnalysisJob[]>([])
  const [history, setHistory] = useState<AIAnalysis[]>([])
  const [active, setActive] = useState<AIAnalysis | null>(null)
  const [compare, setCompare] = useState<AIAnalysis | null>(null)
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [jobError, setJobError] = useState('')
  const [openingReport, setOpeningReport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const completed = useRef(new Set<string>())
  const requestedReport = useRef<string | null>(null)
  const reportRequest = useRef(0)
  const pending = jobs.some(j => ['queued', 'running'].includes(j.state))

  useEffect(() => {
    if (!online) return
    let valid = true
    getAIStatus().then(s => { if (valid) { setStatus(s); setStatusError('') } }).catch(e => { if (valid) setStatusError(asAPIError(e).detail) })
    return () => { valid = false }
  }, [online, projectId, reload])
  useEffect(() => {
    if (!online) return
    let valid = true
    searchProjectAnalyses(projectId, keyword, page).then(result => {
      if (!valid) return
      setHistory(result.items); setTotal(result.total); setHistoryError('')
      setActive(previous => requestedReport.current
        ? result.items.find(r => r.id === requestedReport.current) || (previous?.id === requestedReport.current ? previous : null)
        : result.items.find(r => r.id === previous?.id) || result.items[0] || null)
    }).catch(e => { if (valid) setHistoryError(asAPIError(e).detail) }).finally(() => { if (valid) setLoading(false) })
    return () => { valid = false }
  }, [online, projectId, keyword, page, reload])
  useEffect(() => {
    if (!online) return
    let valid = true
    let sequence = 0
    const poll = () => {
      const current = ++sequence
      return listAnalysisJobs(projectId).then(rows => {
      if (!valid || current !== sequence) return
      setJobs(rows); setJobError('')
      const newlyDone = rows.filter(j => j.state === 'succeeded' && !completed.current.has(j.id))
      rows.filter(j => j.state === 'succeeded').forEach(j => completed.current.add(j.id))
      if (newlyDone.length) { setLoading(true); setReload(v => v + 1) }
    }).catch(e => { if (valid && current === sequence) setJobError(asAPIError(e).detail) })
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, pending ? 3000 : 15000)
    return () => { valid = false; window.clearInterval(timer) }
  }, [online, projectId, pending, reload])
  useEffect(() => () => { reportRequest.current++ }, [])

  function refresh() { setLoading(true); setReload(v => v + 1) }
  function selectReport(report: AIAnalysis | null) {
    reportRequest.current++; requestedReport.current = null; setOpeningReport(false); setActive(report)
  }
  async function viewJob(job: AnalysisJob) {
    if (!job.analysisId) { setError('该后台任务没有关联报告，请刷新后重试。'); return }
    const sequence = ++reportRequest.current
    requestedReport.current = job.analysisId
    if (keyword || page !== 1) setLoading(true)
    setSearch(''); setKeyword(''); setPage(1); setActive(null); setOpeningReport(true); setError('')
    try {
      const report = await getProjectAnalysis(projectId, job.analysisId)
      if (sequence === reportRequest.current) setActive(report)
    } catch (error) {
      if (sequence === reportRequest.current) { requestedReport.current = null; setError(asAPIError(error).detail) }
    } finally { if (sequence === reportRequest.current) setOpeningReport(false) }
  }

  async function start() {
    setBusy(true); setError('')
    try { const job = await startProjectAnalysis(projectId, focus, prompt ?? status?.analysisPrompt ?? ''); setJobs(rows => [job, ...rows.filter(j => j.id !== job.id)]) }
    catch (e) { setError(asAPIError(e).detail) } finally { setBusy(false) }
  }
  async function cancel(job: AnalysisJob) {
    setBusy(true)
    try { const row = await cancelProjectAnalysis(projectId, job.id); setJobs(rows => rows.map(j => j.id === row.id ? row : j)); setError('') }
    catch (e) { setError(asAPIError(e).detail) } finally { setBusy(false) }
  }
  function download(report: AIAnalysis) {
    const blob = new Blob([`# ${projectName} · 项目 AI 分析\n\n${time(report.createdAt)} · ${providerLabel(report.provider)} / ${report.model}\n\n数据截至 ${report.source.asOf}\n\n${report.content}`], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${projectName.replace(/[\\/:*?"<>|]/g, '_')}-AI分析-${report.source.asOf}.md`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  if (!online) return <div className="card p-6 text-sm text-ink-500">连接后端后，可生成真实项目分析、检索历史及确认建议行动。</div>
  return <div ref={container} className="space-y-4">
    <section className="card p-5 space-y-4">
      <div className="flex justify-between gap-4"><div><h2 className="font-semibold flex gap-2 items-center"><Sparkles className="w-5 h-5 text-brand-600" />项目 AI 分析</h2><p className="text-sm text-ink-500 mt-2">后台分析项目快照，核对建议后再转为任务、风险或联动排期。</p></div><Link to="/ai-settings" className="text-sm text-brand-700 shrink-0">AI 设置</Link></div>
      <p className="text-xs text-ink-500">{status?.ready ? `${providerLabel(status.provider)} · ${status.model}` : '请先完成 AI 设置。'} 本次生成会将项目快照发送到已配置模型；结果保存在项目中。</p>
      {canStart ? <><label className="block text-sm">分析提示词<textarea aria-label="分析提示词" className="input mt-2 min-h-32" maxLength={MAX_PROMPT_LENGTH} value={prompt ?? status?.analysisPrompt ?? ''} onChange={e => setPrompt(e.target.value)} /></label>{prompt !== null && <button className="text-xs text-brand-700 underline" onClick={() => setPrompt(null)}>恢复默认提示词</button>}<label className="block text-sm">本次重点关注<textarea aria-label="本次重点关注" className="input mt-2" maxLength={1500} value={focus} onChange={e => setFocus(e.target.value)} placeholder="例如：下两周优先解决哪些阻塞？" /></label><div className="flex items-center justify-between gap-3 flex-wrap"><p className="text-xs text-ink-500">提交后可离开页面，返回时查看后台状态与结果。</p><Button variant="primary" onClick={start} disabled={busy || pending || !status?.ready}>{pending ? '后台分析进行中' : busy ? '提交中…' : '生成后台分析'}</Button></div></> : <p className="text-sm text-ink-500">项目负责人可发起后台分析并确认建议；当前可查看项目分析记录。</p>}
      {jobs.length > 0 && <div className="border-t pt-3 space-y-2"><h3 className="text-sm font-medium">我的后台分析</h3>{jobs.slice(0, 5).map(j => <div key={j.id} className="flex gap-3 justify-between text-sm rounded bg-ink-50 p-3"><div className="min-w-0"><span className="font-medium">{stateNames[j.state]}</span> · {time(j.createdAt)}<p className="text-xs text-ink-500 break-words mt-1">{j.focus || '全面分析'}</p>{j.error && <p className="text-red-700 mt-1">{j.error}</p>}</div>{['queued', 'running'].includes(j.state) && <Button size="sm" disabled={busy} onClick={() => cancel(j)}>取消</Button>}{j.state === 'succeeded' && <Button size="sm" onClick={() => void viewJob(j)}>查看记录</Button>}</div>)}<p className="text-xs text-ink-500">取消后不会保存本次结果；已发送的模型请求可能仍在服务端完成。</p></div>}
    </section>
    {(error || statusError || historyError || jobError) && <p role="alert" className="rounded-lg bg-red-50 text-red-700 p-3 text-sm">{error || statusError || historyError || jobError}<button className="ml-3 underline" onClick={() => { setError(''); refresh() }}>重试加载</button></p>}
    <form className="flex flex-wrap gap-2 items-center" onSubmit={e => { e.preventDefault(); setKeyword(search); setPage(1); selectReport(null); refresh() }}><input className="input max-w-md" aria-label="搜索项目分析记录" placeholder="搜索关注事项或报告正文" value={search} maxLength={200} onChange={e => setSearch(e.target.value)} /><Button size="sm" type="submit">搜索历史</Button><Button size="sm" type="button" onClick={refresh} icon={<RefreshCw className="w-4 h-4" />}>刷新</Button><span className="text-xs text-ink-500">共 {total} 份报告</span></form>
    {openingReport && <p className="text-sm text-ink-500" role="status">正在打开后台分析结果…</p>}
    {loading && <p className="text-sm text-ink-500 flex gap-2"><Loader2 className="w-4 h-4 animate-spin" />加载记录…</p>}
    {!loading && history.length === 0 && <div className="card p-8 text-center text-ink-500 text-sm">{keyword ? '没有匹配的报告。' : '还没有项目分析报告。'}</div>}
    {(active || history.length > 0) && <div className="grid xl:grid-cols-[var(--analysis-list-width)_minmax(0,1fr)] gap-4 items-start" style={{ '--analysis-list-width': `${column.width}px` } as CSSProperties}>
      <aside className="card p-3 relative min-w-0 space-y-2"><h3 className="text-sm font-medium px-2">分析记录</h3><div className="space-y-1 max-h-[600px] overflow-auto">{history.map(r => <button key={r.id} onClick={() => selectReport(r)} className={`w-full text-left rounded p-3 text-xs ${active?.id === r.id ? 'bg-brand-50 text-brand-800' : 'hover:bg-ink-50'}`}><div>{time(r.createdAt)}</div><p className="truncate mt-1" title={r.focus || '全面分析'}>{r.focus || '全面分析'}</p><p className="truncate mt-1 text-ink-500" title={r.model}>{r.model}</p></button>)}</div><div className="flex justify-between items-center text-xs"><Button size="sm" disabled={page === 1 || loading} onClick={() => { selectReport(null); setLoading(true); setPage(v => v - 1) }}>上一页</Button><span>{page}</span><Button size="sm" disabled={page * 20 >= total || loading} onClick={() => { selectReport(null); setLoading(true); setPage(v => v + 1) }}>下一页</Button></div><ColumnResizer label="调整分析记录栏宽度" width={column.width} minWidth={column.minWidth} maxWidth={column.maxWidth} onChange={column.setWidth} onReset={column.resetWidth} className="hidden xl:block" /></aside>
      {active && <div className="space-y-4 min-w-0"><article className="card p-5 min-w-0"><div className="flex flex-wrap justify-between gap-3 border-b pb-3"><div><h3 className="font-semibold">{projectName} · 分析报告</h3><p className="text-xs text-ink-500 mt-2">{time(active.createdAt)} · {providerLabel(active.provider)} / {active.model} · 数据截至 {active.source.asOf}</p></div><div className="flex gap-2"><Button size="sm" onClick={() => setCompare(active)}>加入对比</Button><Button size="sm" icon={<Download className="w-4 h-4" />} onClick={() => download(active)}>导出</Button></div></div>{active.stale && <p className="my-3 text-sm bg-amber-50 text-amber-800 p-3 rounded">项目或分析日期已变化，此报告基于旧快照。执行建议前会按当前数据重新预览。</p>}{active.prompt && <details className="my-3 text-xs"><summary>本次分析提示词</summary><p className="whitespace-pre-wrap mt-2">{active.prompt}</p></details>}<div className="ai-report mt-4"><SafeMarkdown>{active.content}</SafeMarkdown></div></article><AIReportActions key={active.id} projectId={projectId} reportId={active.id} /></div>}
    </div>}
    {compare && <section className="card p-5 space-y-3" aria-label="分析报告对比"><div className="flex justify-between"><h3 className="font-semibold">报告对比</h3><Button size="sm" onClick={() => setCompare(null)}>关闭对比</Button></div>{!active || active.id === compare.id ? <p className="text-sm text-ink-500">已选 {time(compare.createdAt)} 的报告，请从历史中选择另一份报告进行对比。</p> : <div className="grid lg:grid-cols-2 gap-5">{[compare, active].map(r => <article key={r.id} className="min-w-0 rounded border border-ink-200 p-4"><h4 className="text-sm font-medium mb-3">{time(r.createdAt)} · 数据截至 {r.source.asOf}</h4><div className="ai-report max-h-[700px] overflow-auto"><SafeMarkdown>{r.content}</SafeMarkdown></div></article>)}</div>}</section>}
  </div>
}
