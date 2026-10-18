// AI 分析面板 —— 项目分析与财务分析共用的一套体系：
// 同一份 AI 设置（服务商 / 模型）、默认提示词可在本次临时修改、报告存档（最近 20 份）、
// 数据变化后标记过期、导出 Markdown。各场景只提供数据接口与文案。

import { useEffect, useState } from 'react'
import { ArrowRight, Clock3, Download, FileText, Loader2, MessageSquareText, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { aiError, getAIStatus, MAX_PROMPT_LENGTH, providerLabel, type AIAnalysis, type AIAnalysisKind, type AIStatus } from '../../api/ai'
import { Button } from '../ui'
import { useDataStore } from '../../store/data'
import { useAuth } from '../../store/auth'
import { can } from '../../lib/permissions'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'

export interface AIAnalysisPanelProps {
  kind: AIAnalysisKind
  /** 面板标题，如「项目 AI 分析」 */
  title: string
  description: string
  /** 报告标题（也用于导出文件） */
  subject: string
  focusPlaceholder: string
  /** 发送数据前的说明 */
  dataNotice: string
  emptyHint: string
  staleNotice: string
  /** 报告头部的数据标签，如「数据截至 …」「N 项任务」 */
  tags: (report: AIAnalysis) => string[]
  /** 须为稳定引用（useCallback），变化时重新加载 */
  load: () => Promise<AIAnalysis[]>
  generate: (focus: string, prompt: string) => Promise<AIAnalysis>
}

export function AIAnalysisPanel({ kind, title, description, subject, focusPlaceholder, dataNotice, emptyHint, staleNotice, tags, load, generate }: AIAnalysisPanelProps) {
  const online = useDataStore(s => s.mode) === 'api'
  const canConfigureAI = can(useAuth(s => s.currentUser?.role), 'ai.config')
  const version = useDataStore(s => s.version)
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [records, setRecords] = useState<AIAnalysis[]>([])
  const [selected, setSelected] = useState('')
  const [focus, setFocus] = useState('')
  // 分析提示词：null = 使用 AI 设置中的默认提示词；修改后只用于本次生成
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const active = records.find(r => r.id === selected) || records[0]
  const defaultPrompt = (kind === 'finance' ? status?.financeAnalysisPrompt : status?.analysisPrompt) ?? ''
  const prompt = promptDraft ?? defaultPrompt
  const promptEdited = promptDraft !== null && promptDraft !== defaultPrompt

  useEffect(() => {
    let valid = true
    if (!online) return
    Promise.all([getAIStatus(), load()]).then(([s, rows]) => {
      if (valid) { setStatus(s); setRecords(rows); setError(''); setLoading(false) }
    }).catch(e => { if (valid) { setError(aiError(e)); setLoading(false) } })
    return () => { valid = false }
  }, [load, online, version, reload])

  async function run() {
    setGenerating(true); setError('')
    try {
      const report = await generate(focus, prompt)
      setRecords(rows => [report, ...rows].slice(0, 20)); setSelected(report.id)
    } catch (e) { setError(aiError(e)) } finally { setGenerating(false) }
  }

  function download() {
    if (!active) return
    const text = `# ${subject} · AI 分析\n\n分析时间：${formatTime(active.createdAt)}\n\n模型：${providerLabel(active.provider)} / ${active.model}\n\n数据截至：${active.source.asOf}\n\n${active.focus ? `关注事项：${active.focus}\n\n` : ''}${active.content}\n${active.prompt ? `\n---\n\n分析提示词：\n\n${active.prompt}\n` : ''}`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = `${subject.replace(/[\\/:*?"<>|]/g, '_')}-AI分析-${active.source.asOf}.md`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="space-y-4">
      <section className="card p-5 bg-gradient-to-br from-white to-brand-50/50">
        <div className="flex flex-wrap justify-between items-start gap-4">
          <div><h2 className="font-semibold flex items-center gap-2"><Sparkles className="w-5 h-5 text-brand-600" />{title}</h2><p className="text-sm text-ink-500 mt-2">{description}</p></div>
          {/* AI 设置在项目管理「AI设置」中（ai.config：系统管理员 / 项目负责人 cmc_lead） */}
          {canConfigureAI && <Link to="/ai-settings" className="text-sm text-brand-700 flex items-center gap-1">AI设置<ArrowRight className="w-4 h-4" /></Link>}
        </div>
        {!online ? <p className="mt-4 text-sm text-amber-800">当前为离线演示模式。连接后端后，可使用真实数据生成分析。</p> : <>
          <div className="flex items-center gap-2 text-xs text-ink-500 mt-4"><span className={cn('w-2 h-2 rounded-full', status?.ready ? 'bg-emerald-500' : 'bg-amber-400')} />{status?.ready ? `${providerLabel(status.provider)} · ${status.model}` : canConfigureAI ? '尚未完成 AI 配置，请先在项目管理「AI设置」中选择模型。' : '尚未完成 AI 配置，请联系系统管理员在项目管理「AI设置」中选择模型。'}{status?.offlineFallback && <span className="border border-ink-300/60 rounded px-1.5 py-0.5">启用本地备用</span>}</div>
          <div className="mt-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium flex items-center gap-1.5"><MessageSquareText className="w-4 h-4 text-brand-600" />分析提示词 <span className="font-normal text-ink-500">（默认来自 AI 设置，可临时修改，仅本次生效）</span></span>
              {promptEdited && <button className="text-xs text-brand-700 flex items-center gap-1" disabled={generating} onClick={() => setPromptDraft(null)}><RotateCcw className="w-3 h-3" />恢复默认</button>}
            </div>
            <textarea aria-label="分析提示词" className="input resize-y min-h-32 leading-6" maxLength={MAX_PROMPT_LENGTH} disabled={generating || loading} value={prompt} onChange={e => setPromptDraft(e.target.value)} placeholder="留空则使用 AI 设置中的默认提示词" />
            {promptEdited && <p className="text-xs text-amber-700">已临时修改：只用于本次生成，不会改变 AI 设置中的默认提示词。</p>}
          </div>
          <label className="block text-sm mt-4 space-y-2"><span className="font-medium">本次重点关注 <span className="font-normal text-ink-500">（可选）</span></span><textarea className="input resize-y min-h-20" maxLength={1500} disabled={generating} value={focus} onChange={e => setFocus(e.target.value)} placeholder={focusPlaceholder} /></label>
          <div className="flex flex-wrap gap-3 items-center justify-between mt-4">
            <p className="text-xs text-ink-500 max-w-2xl">{dataNotice}</p>
            <Button variant="primary" disabled={generating || loading || !status?.ready} onClick={run} icon={generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}>{generating ? '正在分析…' : records.length ? '重新分析' : '生成分析'}</Button>
          </div>
        </>}
      </section>
      {error && <div role="alert" className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}<button className="underline ml-3" disabled={generating} onClick={() => setReload(v => v + 1)}>刷新状态与记录</button></div>}
      {generating && <div role="status" className="card p-5 flex items-center gap-3 text-sm"><Loader2 className="w-5 h-5 animate-spin text-brand-600" /><div>正在读取本次快照并生成分析<p className="text-xs text-ink-500 mt-1">本地大模型可能需要几分钟；完成后会保存到分析记录。</p></div></div>}
      {online && loading && <div className="py-10 text-center text-sm text-ink-500">正在加载分析记录…</div>}
      {online && !loading && !active && !generating && <div className="card py-14 text-center"><FileText className="w-9 h-9 text-ink-300 mx-auto mb-3" /><h3 className="text-sm font-medium">还没有分析记录</h3><p className="text-xs text-ink-500 mt-2">{emptyHint}</p></div>}
      {active && <div className="grid xl:grid-cols-[220px_1fr] gap-4 items-start">
        <aside className="card p-3 space-y-2">
          <div className="flex items-center justify-between px-2 py-1"><h3 className="text-sm font-medium">最近分析</h3><button title="刷新分析记录" aria-label="刷新分析记录" className="text-ink-500 hover:text-brand-600" onClick={() => setReload(v => v + 1)} disabled={generating}><RefreshCw className="w-3.5 h-3.5" /></button></div>
          <div className="max-h-[600px] overflow-y-auto space-y-1">{records.map(r => <button key={r.id} onClick={() => setSelected(r.id)} className={cn('w-full rounded-md text-left p-3', active.id === r.id ? 'bg-brand-50 text-brand-800' : 'hover:bg-ink-100 text-ink-700')}><div className="text-xs flex gap-1.5 items-center"><Clock3 className="w-3 h-3" />{formatTime(r.createdAt)}</div><div className="text-xs mt-1 truncate">{r.model}</div><div className="text-xs mt-1 truncate opacity-70">{r.focus || '全面分析'}</div></button>)}</div>
          <p className="text-[10px] text-ink-500 px-2">显示最近 20 份报告</p>
        </aside>
        <article className="card p-6 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-300/60 pb-4 mb-5"><div><h3 className="font-semibold text-lg">{subject} · 分析报告</h3><p className="text-xs text-ink-500 mt-2">{formatTime(active.createdAt)} · {providerLabel(active.provider)} / {active.model}{active.usage.fallback ? ' · 云端连接失败，已使用本地备用' : ''}</p></div><Button size="sm" onClick={download} icon={<Download className="w-3.5 h-3.5" />}>导出 Markdown</Button></div>
          <div className="flex flex-wrap gap-2 mb-5 text-xs text-ink-700">{tags(active).map(t => <span className="bg-ink-100 rounded px-2 py-1" key={t}>{t}</span>)}</div>
          {active.stale && <p className="mb-5 text-sm rounded-md p-3 bg-amber-50 text-amber-800">{staleNotice}</p>}
          {active.focus && <p className="text-sm mb-5 p-3 bg-brand-50/50 rounded-md text-ink-700">本次关注：{active.focus}</p>}
          {active.prompt && <details className="mb-5 text-sm rounded-md bg-ink-100/60 p-3"><summary className="cursor-pointer text-ink-700">本次使用的分析提示词{active.prompt === defaultPrompt ? '（当前默认）' : '（自定义）'}</summary><pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-6 text-ink-700">{active.prompt}</pre></details>}
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
