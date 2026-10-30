import { useState, type FormEvent } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import type { TaskInput } from './client'

export default function TaskForm({ initial, busy, error, onSubmit, onCancel }: {
  initial?: TaskInput; busy: boolean; error: string; onSubmit: (input: TaskInput) => void | Promise<void>; onCancel: () => void
}) {
  const [title, setTitle] = useState(initial?.title || ''), [project, setProject] = useState(initial?.project || ''), [instructions, setInstructions] = useState(initial?.instructions || '')
  const invalid = !title.trim() || title.length > 200 || project.length > 200 || instructions.length > 4000
  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || invalid) return
    void onSubmit({ title: title.trim(), project: project.trim(), instructions })
  }
  return <form className="aa-form" onSubmit={submit}>
    <label className="aa-field">任务名称<input required maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="例如：整理本周研究进展" /></label>
    <label className="aa-field">项目<input maxLength={200} value={project} disabled={busy} onChange={event => setProject(event.target.value)} placeholder="可选，填写项目名称以归类任务" /></label>
    <label className="aa-field">任务指引<textarea maxLength={4000} rows={5} value={instructions} disabled={busy} onChange={event => setInstructions(event.target.value)} placeholder="希望 AI 了解的背景、输出格式或写作要求…" /></label>
    <p className="aa-field-help">指引会随每轮对话发送给所选模型。{instructions.length.toLocaleString()} / 4,000 字</p>
    {error && <p className="aa-error" role="alert">{error}</p>}
    <footer><button type="button" className="aa-button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="aa-button aa-primary" disabled={busy || invalid}>{busy ? <LoaderCircle size={15} className="aa-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{busy ? '保存中…' : '保存任务'}</button></footer>
  </form>
}
