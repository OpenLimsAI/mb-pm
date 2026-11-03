import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

interface Props {
  containerRef: RefObject<HTMLDivElement | null>
  conversationRef: RefObject<HTMLElement | null>
  resultRef: RefObject<HTMLElement | null>
  scope: string
  disabled: boolean
}
type Frame = { width: number; minimum: number; maximum: number; defaultRatio: number }
type Drag = { pointerId: number; target: HTMLElement; initial: number | null; next: number | null; cleanup: () => void }

function readRatio(key: string): number | null {
  try {
    const value = localStorage.getItem(key)
    if (value === null || !value.trim()) return null
    const ratio = Number(value)
    return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : null
  } catch { return null }
}
function saveRatio(key: string, ratio: number | null) {
  try {
    if (ratio === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(ratio))
  } catch { /* Resizing remains available when browser storage is unavailable. */ }
}
const clamp = (ratio: number, frame: Frame) => Math.max(frame.minimum, Math.min(frame.maximum, ratio))

export default function AssistantPaneResizer({ containerRef, conversationRef, resultRef, scope, disabled }: Props) {
  const storageKey = `assistant-pane-ratio:${scope}`
  const [ratio, setRatio] = useState(() => readRatio(storageKey))
  const [frame, setFrame] = useState<Frame | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<Drag | null>(null)

  const finish = useCallback((cancel = false) => {
    const current = drag.current
    if (!current) return
    drag.current = null
    current.cleanup()
    try { if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId) } catch { /* Capture can already be lost on blur or removal. */ }
    if (cancel) setRatio(current.initial)
    else if (current.next !== null) saveRatio(storageKey, current.next)
    setDragging(false)
  }, [storageKey])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (ratio === null) {
      container.style.removeProperty('--aa-chat-weight')
      container.style.removeProperty('--aa-result-weight')
    } else {
      container.style.setProperty('--aa-chat-weight', `${ratio * 100}fr`)
      container.style.setProperty('--aa-result-weight', `${(1 - ratio) * 100}fr`)
    }
    return () => {
      container.style.removeProperty('--aa-chat-weight')
      container.style.removeProperty('--aa-result-weight')
    }
  }, [containerRef, ratio])

  useEffect(() => {
    const container = containerRef.current
    if (!container || disabled) return
    let previousWidth = 0
    const measure = () => {
      const conversation = conversationRef.current, result = resultRef.current
      if (window.innerWidth <= 980 || !conversation || !result) {
        finish(); setFrame(null); return
      }
      const width = conversation.getBoundingClientRect().width + result.getBoundingClientRect().width
      const medium = window.innerWidth <= 1150, minimum = medium ? 330 : 360, resultMinimum = medium ? 310 : 340
      if (width <= minimum + resultMinimum) { finish(); setFrame(null); return }
      if (previousWidth && Math.abs(width - previousWidth) > 1) finish()
      previousWidth = width
      const next = { width, minimum: minimum / width, maximum: 1 - resultMinimum / width, defaultRatio: 1 / (medium ? 1.9 : 1.93) }
      setFrame(old => old?.width === next.width && old.minimum === next.minimum && old.defaultRatio === next.defaultRatio ? old : next)
    }
    const resize = () => { finish(); measure() }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(container)
    window.addEventListener('resize', resize)
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); finish() }
  }, [containerRef, conversationRef, resultRef, disabled, finish])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !dragging) return
    container.classList.add('aa-pane-resizing')
    return () => { container.classList.remove('aa-pane-resizing') }
  }, [containerRef, dragging])

  if (disabled || !frame) return null
  const value = clamp(ratio ?? frame.defaultRatio, frame)
  const percent = Math.round(value * 100)
  return <>
    <div className={`aa-pane-resizer${dragging ? ' aa-pane-resizer-active' : ''}`} role="separator" tabIndex={0}
      aria-label="调整对话和结果区宽度" aria-orientation="vertical" aria-controls="aa-chat aa-result-pane"
      aria-valuemin={Math.round(frame.minimum * 100)} aria-valuemax={Math.round(frame.maximum * 100)} aria-valuenow={percent}
      aria-valuetext={`对话区 ${percent}%，结果区 ${100 - percent}%`} title="拖动调整宽度，双击恢复默认；方向键也可调整"
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return
        event.preventDefault()
        const target = event.currentTarget, pointerId = event.pointerId, startX = event.clientX
        target.focus({ preventScroll: true })
        const move = (next: PointerEvent) => {
          if (next.pointerId !== pointerId || !drag.current) return
          next.preventDefault()
          const nextRatio = clamp(value + (next.clientX - startX) / frame.width, frame)
          drag.current.next = nextRatio; setRatio(nextRatio)
        }
        const end = (next: PointerEvent) => { if (next.pointerId === pointerId) finish() }
        const blur = () => finish()
        const escape = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); finish(true) } }
        window.addEventListener('pointermove', move, { passive: false })
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
        window.addEventListener('blur', blur)
        window.addEventListener('keydown', escape)
        drag.current = { pointerId, target, initial: ratio, next: null, cleanup: () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', end)
          window.removeEventListener('pointercancel', end)
          window.removeEventListener('blur', blur)
          window.removeEventListener('keydown', escape)
        } }
        try { target.setPointerCapture?.(pointerId) } catch { /* Window listeners also cover browsers that cannot capture here. */ }
        setDragging(true)
      }}
      onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish() }}
      onKeyDown={event => {
        if (drag.current) return
        const step = (event.shiftKey ? 48 : 16) / frame.width
        const next = event.key === 'ArrowLeft' ? value - step : event.key === 'ArrowRight' ? value + step : event.key === 'Home' ? frame.minimum : event.key === 'End' ? frame.maximum : null
        if (next === null) return
        event.preventDefault()
        const bounded = clamp(next, frame)
        setRatio(bounded); saveRatio(storageKey, bounded)
      }}
      onDoubleClick={() => { finish(true); setRatio(null); saveRatio(storageKey, null) }}
    ><span aria-hidden="true" /></div>
    {dragging && <div className="aa-pane-resize-shield" aria-hidden="true" />}
  </>
}
