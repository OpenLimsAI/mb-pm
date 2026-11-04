import { useState, type FormEvent } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import type { TaskInput } from './client'

export default function TaskForm({ initial, busy, error, onSubmit, onCancel }: {
  initial?: TaskInput; busy: boolean; error: string; onSubmit: (input: TaskInput) => void | Promise<void>; onCancel: () => void
}) {
  const [title, setTitle] = useState(initial?.title || ''), [instructions, setInstructions] = useState(initial?.instructions || '')
  const [memory, setMemory] = useState(initial?.memory || ''), [pinned, setPinned] = useState(initial?.pinned || false)
  const invalid = !title.trim() || title.length > 200 || instructions.length > 4000 || memory.length > 6000
  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || invalid) return
    void onSubmit({ title: title.trim(), instructions, memory, pinned, ...(initial?.finalArtifactId !== undefined ? { finalArtifactId: initial.finalArtifactId } : {}) })
  }
  return <form className="aa-form" onSubmit={submit}>
    <label className="aa-field">任务名称<input required maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="例如：整理本周研究进展" /></label>
    <label className="aa-field">任务指引<textarea maxLength={4000} rows={5} value={instructions} disabled={busy} onChange={event => setInstructions(event.target.value)} placeholder="希望 AI 了解的背景、输出格式或写作要求…" /></label>
    <p className="aa-field-help">指引会随每轮对话发送给所选模型。{instructions.length.toLocaleString()} / 4,000 字</p>
    <label className="aa-field">任务摘要<textarea maxLength={6000} rows={4} value={memory} disabled={busy} onChange={event => setMemory(event.target.value)} placeholder="记录已确认的目标、术语和结论；你可以随时纠正。" /></label>
    <p className="aa-field-help">仅保存你确认的内容。可在回答旁选择“记入任务记忆”后编辑确认；摘要随每轮问题发送，应用数据仍按当前权限重新查询。{memory.length.toLocaleString()} / 6,000 字</p>
    <label className="aa-pin-choice"><input type="checkbox" checked={pinned} disabled={busy} onChange={event => setPinned(event.target.checked)} />置顶此任务</label>
    {error && <p className="aa-error" role="alert">{error}</p>}
    <footer><button type="button" className="aa-button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="aa-button aa-primary" disabled={busy || invalid}>{busy ? <LoaderCircle size={15} className="aa-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{busy ? '保存中…' : '保存任务'}</button></footer>
  </form>
}
