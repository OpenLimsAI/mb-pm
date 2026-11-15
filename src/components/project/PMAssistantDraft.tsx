import { useState, type ReactNode } from 'react'
import type { PMAIRun } from '../../api/pmAI'
import SafeMarkdown from '../SafeMarkdown'
import { Button } from '../ui'

/** Editing a draft never changes the stored report or its evidence/actions. */
export function PMAssistantDraft({ run, children }: { run: PMAIRun; children: ReactNode }) {
  const sections = run.state === 'succeeded' ? run.workflow?.sections ?? [] : []
  const original = [run.result?.summary ?? '', ...(run.result?.findings ?? []).map(item => `### ${item.title}\n\n${item.detail}`), ...sections.map(section => {
    const evidence = section.evidenceIds.map(id => run.source.refs.find(ref => ref.id === id)).filter(ref => !!ref).map(ref => `${ref.title}（${ref.href}）`).join('、')
    return `### ${section.title}\n\n${section.summary}${evidence ? `\n\n依据：${evidence}` : ''}`
  })].join('\n\n')
  const [draft, setDraft] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  const content = draft ?? original
  async function copy() {
    try { await navigator.clipboard.writeText(content); setMessage('草稿已复制。') }
    catch { setMessage('暂时无法自动复制，可编辑草稿后选中文字复制。') }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `项目周报-${run.request.endDate ?? run.createdAt.slice(0, 10)}.md`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section aria-label="周报草稿" className="space-y-3">
    <h4 className="text-xs text-ink-500">可编辑草稿</h4>
    {editing ? <label className="block text-xs text-ink-500">编辑周报草稿<textarea aria-label="编辑周报草稿" className="input mt-2 min-h-64 text-sm" value={content} onChange={event => setDraft(event.target.value)} /></label>
      : draft === null ? children : draft ? <SafeMarkdown>{draft}</SafeMarkdown> : <p className="text-ink-500">草稿内容为空，可继续编辑。</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setEditing(v => !v)}>{editing ? '完成编辑' : '编辑草稿'}</Button><Button size="sm" onClick={() => void copy()}>复制草稿</Button><Button size="sm" onClick={download}>导出草稿</Button></div>
    {message && <p role="status" className="text-xs text-ink-500">{message}</p>}
    {draft !== null && <p className="text-xs text-ink-500">编辑仅用于本地草稿，原始分析及建议依据保留。</p>}
  </section>
}
