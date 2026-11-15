import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle, Trash2 } from 'lucide-react'

export default function NotePurgeDialog({ title, onClose, onConfirm }: {
  title: string; onClose: () => void; onConfirm: () => Promise<void>
}) {
  const dialog = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null)
  const pending = useRef(false), alive = useRef(true), close = useRef(onClose)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!pending.current) close.current() }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])') || [])]
      const first = controls[0], last = controls.at(-1)
      if (!first) { event.preventDefault(); dialog.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { alive.current = false; document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  async function confirm() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await onConfirm() }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '删除未完成，请重试。') }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return createPortal(<div className="pn-overlay"><div ref={dialog} className="pn-purge-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pn-purge-title" aria-describedby="pn-purge-description" aria-busy={busy} tabIndex={-1}>
    <h2 id="pn-purge-title">彻底删除笔记？</h2>
    <p className="pn-purge-note-title">{title}</p>
    <p id="pn-purge-description">删除后无法恢复。只删除这条个人笔记，不影响原始资料。</p>
    {error && <p role="alert" className="pn-error">{error}</p>}
    <div className="pn-purge-dialog-actions"><button ref={cancel} type="button" className="pn-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="pn-button pn-danger" disabled={busy} onClick={() => void confirm()}>{busy ? <LoaderCircle size={15} className="pn-spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}{busy ? '删除中…' : '确认彻底删除'}</button></div>
  </div></div>, document.body)
}
