import { useCallback, useEffect, useRef, useState } from 'react'
import './column-resizer.css'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export interface ColumnResizerProps {
  label: string
  width: number
  minWidth: number
  maxWidth: number
  onChange: (next: number, persist?: boolean) => void
  onReset: () => void
  className?: string
}
type Drag = { pointerId: number; target: HTMLElement; initial: number; next: number; onChange: ColumnResizerProps['onChange']; cleanup: () => void }

export function ColumnResizer({ label, width, minWidth, maxWidth, onChange, onReset, className = '' }: ColumnResizerProps) {
  const drag = useRef<Drag | null>(null)
  const [active, setActive] = useState(false)
  const finish = useCallback((cancel = false) => {
    const current = drag.current
    if (!current) return
    drag.current = null
    current.cleanup()
    try { if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId) } catch { /* Capture may already be released. */ }
    current.onChange(cancel ? current.initial : current.next, !cancel)
    setActive(false)
  }, [])
  useEffect(() => () => {
    const current = drag.current
    if (!current) return
    drag.current = null
    current.cleanup()
    try { if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId) } catch { /* Detached element. */ }
  }, [])
  // Viewport/fullscreen changes invalidate the drag coordinate frame.
  useEffect(() => { finish(true) }, [minWidth, maxWidth, finish])

  return <div className={`column-resizer ${active ? 'is-resizing' : ''} ${className}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuemin={Math.round(minWidth)} aria-valuemax={Math.round(maxWidth)} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} 像素`}
    title="拖动调整列宽；左右键微调；Home / End 到边界；双击恢复默认；Esc 取消拖动"
    onClick={event => event.stopPropagation()}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return
      event.preventDefault(); event.stopPropagation()
      const target = event.currentTarget, pointerId = event.pointerId, startX = event.clientX, body = document.body
      target.focus({ preventScroll: true })
      const oldSelect = body.style.getPropertyValue('user-select'), oldSelectPriority = body.style.getPropertyPriority('user-select')
      const oldCursor = body.style.getPropertyValue('cursor'), oldCursorPriority = body.style.getPropertyPriority('cursor')
      body.style.setProperty('user-select', 'none', 'important'); body.style.setProperty('cursor', 'col-resize', 'important')
      const move = (next: PointerEvent) => {
        const current = drag.current
        if (!current || next.pointerId !== pointerId) return
        next.preventDefault()
        current.next = clamp(width + next.clientX - startX, minWidth, maxWidth)
        current.onChange(current.next, false)
      }
      const end = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(next.type === 'pointercancel') }
      const blur = () => finish()
      const escape = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); finish(true) } }
      const cleanup = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', blur); window.removeEventListener('keydown', escape, true)
        if (oldSelect) body.style.setProperty('user-select', oldSelect, oldSelectPriority); else body.style.removeProperty('user-select')
        if (oldCursor) body.style.setProperty('cursor', oldCursor, oldCursorPriority); else body.style.removeProperty('cursor')
      }
      drag.current = { pointerId, target, initial: width, next: width, onChange, cleanup }
      window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', blur); window.addEventListener('keydown', escape, true)
      try { target.setPointerCapture?.(pointerId) } catch { /* Window listeners retain dragging across boundaries. */ }
      setActive(true)
    }}
    onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish() }}
    onKeyDown={event => {
      if (drag.current) return
      const step = event.shiftKey ? 48 : 16
      const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : null
      if (next === null) return
      event.preventDefault(); event.stopPropagation(); onChange(clamp(next, minWidth, maxWidth))
    }}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); finish(true); onReset() }}
  ><span aria-hidden="true" /></div>
}
