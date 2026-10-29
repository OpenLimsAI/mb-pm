import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Clock3, Download, FileText, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { aiError, generateAIAnalysis, getAIAnalyses, getAIStatus, providerLabels, type AIAnalysis, type AIStatus } from '../../api/ai'
import { Button } from '../ui'
import { useDataStore } from '../../store/data'
import { cn } from '../../lib/cn'

export function ProjectAIAnalysis({ projectId, projectName }: { projectId: string; projectName: string }) {
  const online = useDataStore(s => s.mode) === 'api'
  const version = useDataStore(s => s.version)
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [records, setRecords] = useState<AIAnalysis[]>([])
  const [selected, setSelected] = useState('')
  const [focus, setFocus] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const active = records.find(r => r.id === selected) || records[0]

  useEffect(() => {
    let valid = true
    if (!online) return
    Promise.all([getAIStatus(), getAIAnalyses(projectId)]).then(([s, rows]) => {
      if (valid) { setStatus(s); setRecords(rows); setError(''); setLoading(false) }
    }).catch(e => { if (valid) { setError(aiError(e)); setLoading(false) } })
    return () => { valid = false }
  }, [projectId, online, version, reload])

  async function generate() {
    setGenerating(true); setError('')
    try {
      const report = await generateAIAnalysis(projectId, focus)
      setRecords(rows => [report, ...rows].slice(0, 20)); setSelected(report.id)
    } catch (e) { setError(aiError(e)) } finally { setGenerating(false) }
  }

  function download() {
    if (!active) return
    const text = `# ${projectName} · AI 分析\n\n分析时间：${formatTime(active.createdAt)}\n\n模型：${providerLabels[active.provider]} / ${active.model}\n\n数据截至：${active.source.asOf}\n\n${active.focus ? `关注事项：${active.focus}\n\n` : ''}${active.content}\n`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = `${projectName.replace(/[\\/:*?"<>|]/g, '_')}-AI分析-${active.source.asOf}.md`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="space-y-4">
      <section className="card p-5 bg-gradient-to-br from-white to-brand-50/50">
        <div className="flex flex-wrap justify-between items-start gap-4">
          <div><h2 className="font-semibold flex items-center gap-2"><Sparkles className="w-5 h-5 text-brand-600" />项目 AI 分析</h2><p className="text-sm text-ink-500 mt-2">结合进度、里程碑、依赖、团队、预算与最新基线，生成有依据的管理建议。</p></div>
          <Link to="/settings" className="text-sm text-brand-700 flex items-center gap-1">AI 设置<ArrowRight className="w-4 h-4" /></Link>
        </div>
        {!online ? <p className="mt-4 text-sm text-amber-800">当前为离线演示模式。连接后端后，可使用真实项目数据生成分析。</p> : <>
          <div className="flex items-center gap-2 text-xs text-ink-500 mt-4"><span className={cn('w-2 h-2 rounded-full', status?.ready ? 'bg-emerald-500' : 'bg-amber-400')} />{status?.ready ? `${providerLabels[status.provider]} · ${status.model}` : '尚未完成 AI 配置，请先在设置中选择模型。'}{status?.offlineFallback && <span className="border border-ink-300/60 rounded px-1.5 py-0.5">启用本地备用</span>}</div>
          <label className="block text-sm mt-4 space-y-2"><span className="font-medium">本次重点关注 <span className="font-normal text-ink-500">（可选）</span></span><textarea className="input resize-y min-h-20" maxLength={1500} disabled={generating} value={focus} onChange={e => setFocus(e.target.value)} placeholder="例如：哪些里程碑可能延期？下两周应优先解决哪些阻塞？预算是否支持当前计划？" /></label>
          <div className="flex flex-wrap gap-3 items-center justify-between mt-4">
            <p className="text-xs text-ink-500 max-w-2xl">点击后将项目资料发送至已配置的模型服务。分析结果仅作为管理参考，不会自动修改项目数据。</p>
            <Button variant="primary" disabled={generating || loading || !status?.ready} onClick={generate} icon={generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}>{generating ? '正在分析…' : records.length ? '重新分析' : '生成分析'}</Button>
          </div>
        </>}
      </section>
      {error && <div role="alert" className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}<button className="underline ml-3" disabled={generating} onClick={() => setReload(v => v + 1)}>刷新状态与记录</button></div>}
      {generating && <div role="status" className="card p-5 flex items-center gap-3 text-sm"><Loader2 className="w-5 h-5 animate-spin text-brand-600" /><div>正在读取本次快照并生成分析<p className="text-xs text-ink-500 mt-1">本地大模型可能需要几分钟；完成后会保存到分析记录。</p></div></div>}
      {online && loading && <div className="py-10 text-center text-sm text-ink-500">正在加载分析记录…</div>}
      {online && !loading && !active && !generating && <div className="card py-14 text-center"><FileText className="w-9 h-9 text-ink-300 mx-auto mb-3" /><h3 className="text-sm font-medium">还没有分析记录</h3><p className="text-xs text-ink-500 mt-2">完成 AI 设置后，生成第一份项目分析报告。</p></div>}
      {active && <div className="grid xl:grid-cols-[220px_1fr] gap-4 items-start">
        <aside className="card p-3 space-y-2">
          <div className="flex items-center justify-between px-2 py-1"><h3 className="text-sm font-medium">最近分析</h3><button title="刷新分析记录" aria-label="刷新分析记录" className="text-ink-500 hover:text-brand-600" onClick={() => setReload(v => v + 1)} disabled={generating}><RefreshCw className="w-3.5 h-3.5" /></button></div>
          <div className="max-h-[600px] overflow-y-auto space-y-1">{records.map(r => <button key={r.id} onClick={() => setSelected(r.id)} className={cn('w-full rounded-md text-left p-3', active.id === r.id ? 'bg-brand-50 text-brand-800' : 'hover:bg-ink-100 text-ink-700')}><div className="text-xs flex gap-1.5 items-center"><Clock3 className="w-3 h-3" />{formatTime(r.createdAt)}</div><div className="text-xs mt-1 truncate">{r.model}</div><div className="text-xs mt-1 truncate opacity-70">{r.focus || '全面分析'}</div></button>)}</div>
          <p className="text-[10px] text-ink-500 px-2">显示最近 20 份报告</p>
        </aside>
        <article className="card p-6 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-300/60 pb-4 mb-5"><div><h3 className="font-semibold text-lg">{projectName} · 分析报告</h3><p className="text-xs text-ink-500 mt-2">{formatTime(active.createdAt)} · {providerLabels[active.provider]} / {active.model}{active.usage.fallback ? ' · 云端连接失败，已使用本地备用' : ''}</p></div><Button size="sm" onClick={download} icon={<Download className="w-3.5 h-3.5" />}>导出 Markdown</Button></div>
          <div className="flex flex-wrap gap-2 mb-5 text-xs text-ink-700">{[`数据截至 ${active.source.asOf}`, `${active.source.taskCount} 项任务`, `${active.source.milestoneCount} 个里程碑`, `${active.source.overdueCount} 项逾期`].map(t => <span className="bg-ink-100 rounded px-2 py-1" key={t}>{t}</span>)}</div>
          {active.stale && <p className="mb-5 text-sm rounded-md p-3 bg-amber-50 text-amber-800">项目数据或分析日期已变化，这份报告基于旧快照。请重新分析获取最新结论。</p>}
          {active.focus && <p className="text-sm mb-5 p-3 bg-brand-50/50 rounded-md text-ink-700">本次关注：{active.focus}</p>}
          <div className="ai-report"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt || '图片已省略'}</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{active.content}</Markdown></div>
        </article>
      </div>}
    </div>
  )
}

function formatTime(value: string) {
  // SQLite drops timezone metadata; persisted timestamps are UTC.
  const utc = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z'
  return new Date(utc).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
