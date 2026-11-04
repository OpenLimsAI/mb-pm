import { useState, type FormEvent } from 'react'
import type { AssistantMessage } from './client'

const categories = ['目标', '约束', '已确认结论', '待解决问题'] as const
function memoryEntry(memory: string, category: string, source: string, content: string) {
  return [memory.trim(), `【${category} · 来源：${source}】\n${content.trim()}`].filter(Boolean).join('\n\n')
}

export default function MemoryForm({ memory, answer, turn, busy, error, onSave, onCancel }: {
  memory: string; answer: AssistantMessage; turn: number; busy: boolean; error: string
  onSave: (memory: string) => void; onCancel: () => void
}) {
  const [category, setCategory] = useState<string>('已确认结论'), [content, setContent] = useState(answer.content)
  const source = `第 ${turn} 轮回答（${new Date(answer.createdAt).toLocaleString('zh-CN')}）`
  const proposed = memoryEntry(memory, category, source, content)
  const invalid = !content.trim() || proposed.length > 6000
  function submit(event: FormEvent) { event.preventDefault(); if (!busy && !invalid) onSave(proposed) }
  return <form className="aa-form" onSubmit={submit}>
    <p className="aa-field-help">来源：{source}。请核对并精简后保存，未确认的内容可归为“待解决问题”。</p>
    <label className="aa-field">记忆类型<select value={category} disabled={busy} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</select></label>
    <label className="aa-field">记忆内容<textarea rows={7} value={content} disabled={busy} onChange={event => setContent(event.target.value)} /></label>
    <details className="aa-memory-preview" open><summary>保存后的任务记忆预览 · {proposed.length.toLocaleString()} / 6,000 字</summary><pre>{proposed}</pre></details>
    {proposed.length > 6000 && <p className="aa-error" role="alert">合并后超过 6,000 字，请精简本条内容；已有记忆可在任务设置中编辑。</p>}
    {error && <p className="aa-error" role="alert">{error}</p>}
    <footer><button className="aa-button" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="aa-button aa-primary" type="submit" disabled={busy || invalid}>{busy ? '保存中…' : '确认并保存记忆'}</button></footer>
  </form>
}
