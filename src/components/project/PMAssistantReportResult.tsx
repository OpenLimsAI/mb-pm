import { useEffect, useRef, useState } from 'react'
import { type AIAnalysis, providerLabel } from '../../api/ai'
import { cancelProjectAnalysis, getProjectAnalysis, listAnalysisJobs, type AnalysisJob } from '../../api/projectAIWork'
import { asAPIError } from '../../api/client'
import { projectAnalysisText } from '../../lib/projectAnalysisText'
import SafeMarkdown from '../SafeMarkdown'
import { Button } from '../ui'
import { AIReportActions } from './AIReportActions'

export interface AssistantReport {
  requestId?: number
  kind: 'project' | 'finance'
  question: string
  projectId?: string
  job?: AnalysisJob
  report?: AIAnalysis
  pending?: boolean
}

/** Only the explicitly requested report belongs here. Full legacy history remains opt-in. */
export function PMAssistantReportResult({ value, disabled }: { value: AssistantReport; disabled: boolean }) {
  const [job, setJob] = useState(value.job)
  const [report, setReport] = useState(value.report)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState<string | null>(null)
  const [copyError, setCopyError] = useState('')
  const attempt = useRef(0)
  const mounted = useRef(true)
  const jobId = job?.id
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const active = job?.state === 'queued' || job?.state === 'running'
  const valueReport = value.report
  useEffect(() => {
    if (!value.projectId || !jobId) return
    let valid = true
    let timer: ReturnType<typeof setTimeout>
    const version = ++attempt.current
    const read = async () => {
      try {
        const rows = await listAnalysisJobs(value.projectId!)
        if (!valid || attempt.current !== version) return
        const current = rows.find(item => item.id === jobId)
        if (!current) { setError('暂未找到本次后台任务，可从历史报告查看。'); return }
        setJob(current)
        if (current.state === 'queued' || current.state === 'running') setError('')
        if (current.state === 'succeeded' && current.analysisId) {
          setReading(true)
          const result = await getProjectAnalysis(value.projectId!, current.analysisId)
          if (valid && attempt.current === version) { setReport(result); setError(''); setReading(false) }
        } else if (current.state === 'failed') setError(current.error || '这次综合评估未完成，可以调整要求后重新发送。')
        else if (current.state === 'queued' || current.state === 'running') timer = setTimeout(read, 2500)
      } catch (failure) {
        if (!valid || attempt.current !== version) return
        setReading(false)
        const e = asAPIError(failure)
        if (e.status === 403 || e.status === 404) { setReport(undefined); setError(e.detail); return }
        setError('暂未取得本次报告状态，正在重试。'); timer = setTimeout(read, 4000)
      }
    }
    void read()
    return () => { valid = false; clearTimeout(timer) }
    // A completed fetch updates the same job; it must not restart polling from its older prop.
  }, [value.projectId, jobId, reload])
  const current = valueReport ?? report
  const content = current ? projectAnalysisText(current.content) : ''
  const body = edited ?? content
  async function stop() {
    if (!value.projectId || !job || !active) return
    const version = ++attempt.current
    try {
      const stopped = await cancelProjectAnalysis(value.projectId, job.id)
      if (mounted.current && attempt.current === version) { setJob(stopped); setError('') }
    } catch (failure) { if (mounted.current && attempt.current === version) { setError(asAPIError(failure).detail); setReload(v => v + 1) } }
  }
  function download() {
    if (!current) return
    const markdown = `# ${value.kind === 'finance' ? '组合财务评估' : '项目综合评估'}\n\n数据截至 ${current.source.asOf}\n\n${body}`
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `项目报告-${current.source.asOf}.md`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function copy() {
    try { await navigator.clipboard.writeText(body); setCopyError('内容已复制。') }
    catch { setCopyError('暂时无法自动复制，可以编辑草稿后选中内容复制。') }
  }
  return <section aria-label="当前综合报告" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{value.kind === 'finance' ? '组合财务评估' : '项目综合评估'}</h3>{active && <Button size="sm" onClick={() => void stop()}>停止整理</Button>}</div>
    {(active || value.pending || reading) && <p role="status" className="text-ink-500">正在整理本次报告，可先处理其他问题；结果将保存在相应报告历史中。</p>}
    {job?.state === 'cancelled' && <p role="status">这次整理已停止。</p>}
    {job && <Button size="sm" onClick={() => setReload(v => v + 1)}>更新报告状态</Button>}
    {error && <p role="alert" className="break-words text-amber-800">{error}</p>}
    {current && <>
      {editing ? <label className="block text-xs text-ink-500">编辑报告草稿<textarea className="input mt-2 min-h-64 text-sm" aria-label="编辑报告草稿" value={body} onChange={event => setEdited(event.target.value)} /></label> : <div className="ai-report"><SafeMarkdown>{body}</SafeMarkdown></div>}
      <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setEditing(v => !v)}>{editing ? '完成编辑' : '编辑草稿'}</Button><Button size="sm" onClick={() => void copy()}>复制内容</Button><Button size="sm" onClick={download}>导出报告</Button></div>
      {copyError && <p role="status" className="text-xs text-ink-500">{copyError}</p>}
      {current.stale && <p className="text-xs text-amber-800">报告基于生成时快照，项目记录已有变化。</p>}
      <details><summary className="cursor-pointer text-xs text-ink-500">查看资料范围</summary><p className="mt-2 text-xs text-ink-500">{value.projectId ? '当前评估项目' : '全部可见项目'} · 数据截至{current.source.asOf} · {providerLabel(current.provider)} / {current.model}。本地编辑只修改草稿，原始报告及建议依据保留。</p></details>
      {value.kind === 'project' && value.projectId && <details><summary className="cursor-pointer font-medium">核对报告建议</summary><div className="mt-3"><fieldset disabled={disabled}><AIReportActions key={current.id} projectId={value.projectId} reportId={current.id} /></fieldset></div></details>}
    </>}
  </section>
}
