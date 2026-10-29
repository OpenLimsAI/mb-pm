import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { moduleLabels } from './layout'
import type { WorkspaceLayout, WorkspaceModule } from './layout'
import { getStackHeight, getTrackSizes, resetTrackSizes, resizeStackPair, resizeTrackPair, setTrackSizes } from './workspaceSizing'
import type { WorkspaceSizes } from './workspaceSizing'
import './workspaceSizing.css'

interface Props {
  containerRef: RefObject<HTMLDivElement | null>
  layout: WorkspaceLayout
  visible: Record<WorkspaceModule, boolean>
  sizes: WorkspaceSizes
  onChange: (sizes: WorkspaceSizes) => void
  disabled?: boolean
}
type Axis = 'columns' | 'rows'
type Divider = { id: string; axis: Axis; index: number; left: number; top: number; length: number; available: number; mobile: boolean; before?: WorkspaceModule; after?: WorkspaceModule }
type Drag = { pointerId: number; divider: Divider; start: number; sizes: WorkspaceSizes; layout: WorkspaceLayout; visible: Props['visible']; target: HTMLElement; onChange: Props['onChange']; cleanup: () => void }
const emptyFrame: Divider[] = []

function measure(container: HTMLDivElement, layout: WorkspaceLayout, visible: Props['visible'], sizes: WorkspaceSizes): Divider[] {
  const origin = container.getBoundingClientRect(), style = getComputedStyle(container)
  const boxes = layout.order.flatMap(module => {
    if (!visible[module]) return []
    const element = container.querySelector<HTMLElement>(`:scope > [data-module="${module}"]`)
    if (!element || element.hidden) return []
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return []
    return [{ module, left: rect.left - origin.left - container.clientLeft + container.scrollLeft, right: rect.right - origin.left - container.clientLeft + container.scrollLeft, top: rect.top - origin.top - container.clientTop + container.scrollTop, bottom: rect.bottom - origin.top - container.clientTop + container.scrollTop, width: rect.width, height: rect.height }]
  })
  if (boxes.length < 2) return []
  const mobile = window.innerWidth <= 900
  if (mobile) {
    const sorted = [...boxes].sort((a, b) => a.top - b.top)
    return sorted.slice(0, -1).map((box, index) => {
      const next = sorted[index + 1], left = Math.max(box.left, next.left), right = Math.min(box.right, next.right)
      return { id: `mobile:${box.module}:${next.module}`, axis: 'rows', index, left, top: (box.bottom + next.top) / 2, length: Math.max(0, right - left), available: box.height + next.height, mobile: true, before: box.module, after: next.module }
    })
  }
  const tracks = getTrackSizes(layout, visible, sizes), result: Divider[] = []
  const addAxis = (axis: Axis) => {
    if (tracks[axis].length < 2) return
    const isColumn = axis === 'columns', gap = Number.parseFloat(isColumn ? style.columnGap : style.rowGap) || 7
    const segments: { position: number; start: number; end: number }[] = []
    for (const a of boxes) for (const b of boxes) {
      if (a.module === b.module) continue
      const distance = isColumn ? b.left - a.right : b.top - a.bottom
      const start = isColumn ? Math.max(a.top, b.top) : Math.max(a.left, b.left)
      const end = isColumn ? Math.min(a.bottom, b.bottom) : Math.min(a.right, b.right)
      if (distance < -1 || distance > Math.max(32, gap + 2) || end - start < 4) continue
      segments.push({ position: isColumn ? (a.right + b.left) / 2 : (a.bottom + b.top) / 2, start, end })
    }
    segments.sort((a, b) => a.position - b.position || a.start - b.start)
    const groups: typeof segments = []
    for (const segment of segments) {
      const previous = groups.at(-1)
      if (previous && Math.abs(previous.position - segment.position) < 2 && segment.start <= previous.end + gap + 2) previous.end = Math.max(previous.end, segment.end)
      else groups.push({ ...segment })
    }
    const extent = (isColumn ? Math.max(...boxes.map(box => box.right)) - Math.min(...boxes.map(box => box.left)) : Math.max(...boxes.map(box => box.bottom)) - Math.min(...boxes.map(box => box.top))) - gap * (tracks[axis].length - 1)
    groups.slice(0, tracks[axis].length - 1).forEach((line, index) => result.push({ id: `${axis}:${index}`, axis, index, left: isColumn ? line.position : line.start, top: isColumn ? line.start : line.position, length: line.end - line.start, available: Math.max(1, extent), mobile: false }))
  }
  addAxis('columns'); addAxis('rows')
  return result
}

function changedSizes(divider: Divider, initial: WorkspaceSizes, layout: WorkspaceLayout, visible: Props['visible'], delta: number): WorkspaceSizes {
  if (divider.mobile && divider.before && divider.after) return resizeStackPair(initial, divider.before, divider.after, delta)
  const tracks = getTrackSizes(layout, visible, initial)
  return setTrackSizes(initial, layout, visible, divider.axis, resizeTrackPair(tracks[divider.axis], divider.index, delta, divider.available, divider.axis === 'columns' ? 240 : 160))
}

function limits(divider: Divider, sizes: WorkspaceSizes, layout: WorkspaceLayout, visible: Props['visible']) {
  if (divider.mobile && divider.before && divider.after) {
    const first = getStackHeight(divider.before, sizes), second = getStackHeight(divider.after, sizes)
    return { first, second, min: Math.max(240, first + second - 4000), max: Math.min(4000, first + second - 240), value: first, text: `${Math.round(first)} / ${Math.round(second)} 像素` }
  }
  const values = getTrackSizes(layout, visible, sizes)[divider.axis], first = values[divider.index] * divider.available, second = values[divider.index + 1] * divider.available
  const total = first + second, minimum = Math.min(divider.axis === 'columns' ? 240 : 160, total / 2)
  return { first, second, min: total ? Math.round(minimum / total * 100) : 50, max: total ? Math.round((total - minimum) / total * 100) : 50, value: total ? Math.round(first / total * 100) : 50, text: `${Math.round(first)} / ${Math.round(second)} 像素` }
}

export default function WorkspaceResizers({ containerRef, layout, visible, sizes, onChange, disabled = false }: Props) {
  const [dividers, setDividers] = useState<Divider[]>(emptyFrame), [dragAxis, setDragAxis] = useState<Axis | null>(null)
  const drag = useRef<Drag | null>(null)
  const order = layout.order.join(','), visibility = `${visible.editor}:${visible.knowledge}:${visible.ai}`

  function finish(cancel = false) {
    const current = drag.current
    if (!current) return
    drag.current = null; current.cleanup()
    try { if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId) } catch { /* The pointer may already have been released by the browser. */ }
    if (cancel) current.onChange(current.sizes)
    setDragAxis(null)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container || disabled) return
    let frame = 0
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setDividers(measure(container, layout, visible, sizes))) }
    schedule()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    observer?.observe(container)
    container.querySelectorAll<HTMLElement>(':scope > [data-module]').forEach(element => observer?.observe(element))
    window.addEventListener('resize', schedule)
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', schedule) }
  }, [containerRef, layout, visible, sizes, disabled])

  useEffect(() => () => {
    const current = drag.current
    if (current) { drag.current = null; current.cleanup(); setDragAxis(null); try { if (current.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId) } catch { /* Detached separators cannot retain capture. */ } }
  }, [disabled, order, visibility, layout.arrangement])

  function start(event: React.PointerEvent<HTMLDivElement>, divider: Divider) {
    if (disabled || event.button !== 0 || drag.current || !containerRef.current) return
    event.preventDefault()
    const container = containerRef.current, target = event.currentTarget, body = document.body
    const previousSelect = body.style.getPropertyValue('user-select'), selectPriority = body.style.getPropertyPriority('user-select')
    const previousCursor = body.style.getPropertyValue('cursor'), cursorPriority = body.style.getPropertyPriority('cursor')
    const previousClass = container.classList.contains('ks-workspace-resizing')
    body.style.setProperty('user-select', 'none', 'important'); body.style.setProperty('cursor', divider.axis === 'columns' ? 'col-resize' : 'row-resize', 'important'); container.classList.add('ks-workspace-resizing')
    const move = (pointer: PointerEvent) => {
      const current = drag.current
      if (!current || pointer.pointerId !== current.pointerId) return
      pointer.preventDefault()
      const position = current.divider.axis === 'columns' ? pointer.clientX : pointer.clientY
      current.onChange(changedSizes(current.divider, current.sizes, current.layout, current.visible, position - current.start))
    }
    const end = (pointer: PointerEvent) => { if (pointer.pointerId === drag.current?.pointerId) finish() }
    const blur = () => finish()
    const escape = (keyboard: KeyboardEvent) => { if (keyboard.key === 'Escape') { keyboard.preventDefault(); finish(true) } }
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', blur); window.removeEventListener('keydown', escape)
      if (previousSelect) body.style.setProperty('user-select', previousSelect, selectPriority); else body.style.removeProperty('user-select')
      if (previousCursor) body.style.setProperty('cursor', previousCursor, cursorPriority); else body.style.removeProperty('cursor')
      if (!previousClass) container.classList.remove('ks-workspace-resizing')
    }
    drag.current = { pointerId: event.pointerId, divider, start: divider.axis === 'columns' ? event.clientX : event.clientY, sizes, layout, visible, target, onChange, cleanup }
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', blur); window.addEventListener('keydown', escape)
    try { target.setPointerCapture(event.pointerId) } catch { /* Window listeners also support browsers without capture. */ }
    target.focus({ preventScroll: true }); setDragAxis(divider.axis)
  }

  function keyboard(event: React.KeyboardEvent<HTMLDivElement>, divider: Divider) {
    const amount = event.shiftKey ? 48 : 16, negative = divider.axis === 'columns' ? 'ArrowLeft' : 'ArrowUp', positive = divider.axis === 'columns' ? 'ArrowRight' : 'ArrowDown'
    let delta = event.key === negative ? -amount : event.key === positive ? amount : null
    const bounds = limits(divider, sizes, layout, visible)
    if (event.key === 'Home') delta = -(bounds.first + bounds.second)
    if (event.key === 'End') delta = bounds.first + bounds.second
    if (delta === null) return
    event.preventDefault(); onChange(changedSizes(divider, sizes, layout, visible, delta))
  }
  function reset(divider: Divider) {
    if (divider.mobile && divider.before && divider.after) {
      const mobile = { ...sizes.mobile }; delete mobile[divider.before]; delete mobile[divider.after]
      onChange({ ...sizes, mobile })
    } else onChange(resetTrackSizes(sizes, layout, visible, divider.axis))
  }

  if (disabled || Object.values(visible).filter(Boolean).length < 2) return null
  return <div className="ks-workspace-resizers">
    {dividers.map(divider => {
      const bounds = limits(divider, sizes, layout, visible)
      const label = divider.mobile && divider.before && divider.after ? `调整${moduleLabels[divider.before]}与${moduleLabels[divider.after]}的高度` : `调整模块${divider.axis === 'columns' ? '列宽' : '行高'} ${divider.index + 1}`
      return <div key={divider.id} className={`ks-workspace-resizer ks-workspace-resizer-${divider.axis}`} role="separator" aria-label={label} aria-orientation={divider.axis === 'columns' ? 'vertical' : 'horizontal'} aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={bounds.value} aria-valuetext={bounds.text} tabIndex={0}
        title="拖动调整尺寸；方向键微调；Home / End 到边界；双击恢复此方向的默认尺寸"
        style={divider.axis === 'columns' ? { left: divider.left - 4, top: divider.top, width: 8, height: divider.length } : { left: divider.left, top: divider.top - 4, width: divider.length, height: 8 }}
        onPointerDown={event => start(event, divider)} onLostPointerCapture={() => finish()} onKeyDown={event => keyboard(event, divider)} onDoubleClick={() => reset(divider)}><span /></div>
    })}
    {dragAxis && <div className={`ks-workspace-resize-shield ks-workspace-resize-shield-${dragAxis}`} aria-hidden="true" />}
  </div>
}
