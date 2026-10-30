import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export default function AssistantDialog({ title, description, onClose, children, wide = false }: {
  title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean
}) {
  const titleId = useId(), descriptionId = useId(), dialog = useRef<HTMLDivElement>(null), closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, element = dialog.current
    const initial = element?.querySelector<HTMLElement>('input:not([disabled]):not([hidden]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled])')
    ;(initial || element)?.focus({ preventScroll: true })
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return }
      if (event.key !== 'Tab' || !element) return
      const controls = [...element.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(control => !control.hidden && control.getAttribute('aria-hidden') !== 'true')
      const first = controls[0], last = controls.at(-1)
      if (!first) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element || !element.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<div className="aa-modal-backdrop"><div className={`aa-modal${wide ? ' aa-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} ref={dialog} tabIndex={-1}>
    <header className="aa-modal-heading"><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><button type="button" className="aa-button" aria-label="关闭窗口" onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    {children}
  </div></div>, document.body)
}
