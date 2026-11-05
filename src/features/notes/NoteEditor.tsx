import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ExternalLink, Link2, LoaderCircle, NotebookPen, X } from 'lucide-react'
import { noteSourceNames, noteSourceUrl, validateNote } from './client'
import type { NotesClient, PersonalNote } from './client'
import type { NoteDraft } from './draft'
import './notes.css'

export default function NoteEditor({ client, draft, existing, onClose, onSaved, inline = false, onStateChange }: {
  client: NotesClient; draft: NoteDraft; existing?: PersonalNote; onClose: () => void; onSaved: (note: PersonalNote) => void
  inline?: boolean; onStateChange?: (state: { dirty: boolean; busy: boolean }) => void
}) {
  const [title, setTitle] = useState(draft.title), [content, setContent] = useState(draft.content)
  const [draftClient] = useState(client)
  const accountChanged = client !== draftClient
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false), alive = useRef(true), dialog = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const dirty = title !== draft.title || content !== draft.content
  useEffect(() => { onStateChange?.({ dirty, busy }) }, [dirty, busy, onStateChange])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    alive.current = true
    if (inline) return () => { alive.current = false }
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!pending.current) closeRef.current() }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href]') || [])]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { alive.current = false; document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [inline])
  async function save() {
    if (pending.current || accountChanged) return
    const input = { title: title.trim(), content, sourceApp: draft.sourceApp, sourceTitle: draft.sourceTitle, sourceUrl: draft.sourceUrl }
    try { validateNote(input) } catch (reason) { setError(reason instanceof Error ? reason.message : '请检查笔记内容。'); return }
    pending.current = true; setBusy(true); setError('')
    try {
      const result = existing ? await draftClient.save(existing, input) : await draftClient.create(draft.id, input)
      if (alive.current) onSaved(result)
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '笔记未能保存，当前内容已保留。') }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const editor = <div className={inline ? 'pn-inline-editor' : 'pn-dialog'} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-label={existing ? '编辑笔记' : '存入我的笔记'} ref={dialog} tabIndex={-1}>
    <header><span className="pn-dialog-icon"><NotebookPen size={20} aria-hidden="true" /></span><div><h2>{existing ? '编辑笔记' : '存入我的笔记'}</h2><p>保留阅读摘录，记录自己的思考。</p></div><button className="pn-button pn-close" type="button" disabled={busy} onClick={onClose} aria-label="关闭笔记窗口"><X size={19} aria-hidden="true" /></button></header>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="pn-editor-fields">
        <label className="pn-field pn-title-field">笔记标题<input required autoFocus value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="为这条笔记起个名字" /></label>
        <label className="pn-field pn-content-field">笔记正文<textarea required value={content} maxLength={50000} disabled={busy} onChange={event => setContent(event.target.value)} rows={9} placeholder="写下摘录、观察与想法…" /></label>
        <p className="pn-caption">{content.length.toLocaleString()} / 50,000 字{content.length > 50000 && ' · 请缩短正文后保存'}</p>
        <div className="pn-origin"><span className="pn-source-badge"><NotebookPen size={13} aria-hidden="true" />{noteSourceNames[draft.sourceApp]}</span>{draft.sourceTitle && <strong><Link2 size={13} aria-hidden="true" />{draft.sourceTitle}</strong>}{noteSourceUrl(draft.sourceUrl) && <a href={noteSourceUrl(draft.sourceUrl)} target="_blank" rel="noreferrer">查看来源<ExternalLink size={12} aria-hidden="true" /></a>}</div>
        {(accountChanged || error) && <p role="alert" className="pn-error">{accountChanged ? '登录账号已变化，当前草稿已保留。请复制正文，并使用原账号重新打开笔记。' : error}</p>}
      </div>
      <footer><span className="pn-save-hint">保存到个人笔记</span><button className="pn-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="pn-button pn-primary" type="submit" disabled={busy || accountChanged || !title.trim() || !content.trim() || content.length > 50000}>{busy ? <LoaderCircle size={15} className="pn-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{busy ? '保存中…' : '保存笔记'}</button></footer>
    </form>
  </div>
  return inline ? editor : createPortal(<div className="pn-overlay">{editor}</div>, document.body)
}
