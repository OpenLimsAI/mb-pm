import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { useKnowledgePreference } from './preferences'
import './resizable-shell.css'

const DEFAULT_WIDTH = 212, MIN_WIDTH = 180, MAX_WIDTH = 420
export default function ResizableKnowledgeShell({ storageKey, sidebar, children }: { storageKey: string; sidebar: ReactNode; children: ReactNode }) {
  const shell = useRef<HTMLDivElement>(null)
  const [savedWidth, setWidth] = useKnowledgePreference(`${storageKey}:sidebar-width`, DEFAULT_WIDTH)
  const width = Number.isFinite(savedWidth) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, savedWidth)) : DEFAULT_WIDTH
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => { const current = drag.current; if (current?.pointerId === event.pointerId) resize(current.startWidth + event.clientX - current.startX) }
    const up = () => { drag.current = null }
    const cancel = () => { if (drag.current) setWidth(drag.current.startWidth); drag.current = null }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel) }
    // The listener keeps the start position through rerenders while dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setWidth])
  function resize(value: number) {
    const available = shell.current?.getBoundingClientRect().width || 1000
    setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - 340, value))))
  }
  function end(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    if (drag.current?.pointerId !== event.pointerId) return
    if (cancelled) setWidth(drag.current.startWidth)
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }
  return <div ref={shell} className="kso-shell kso-resizable-shell" style={{ '--kso-sidebar-width': `${width}px` } as CSSProperties}>
    {sidebar}
    <div className="kso-sidebar-resizer" role="separator" aria-label="调整文件夹栏宽度" aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width} tabIndex={0} title="左右拖动调整宽度，双击恢复默认" onDoubleClick={() => setWidth(DEFAULT_WIDTH)} onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Escape'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Escape') { if (drag.current) setWidth(drag.current.startWidth); drag.current = null; return }
      resize(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? MAX_WIDTH : event.key === 'Enter' ? DEFAULT_WIDTH : width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10))
    }} />
    {children}
  </div>
}
