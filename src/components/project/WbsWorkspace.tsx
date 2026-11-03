import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { GanttChartSquare, Maximize2, Minimize2, Rows3, Table2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import './wbs-workspace.css'

export type WbsView = 'table' | 'tree' | 'gantt'
const views = [
  { value: 'table', label: '表格录入', icon: Table2 },
  { value: 'tree', label: '树形', icon: Rows3 },
  { value: 'gantt', label: '甘特图', icon: GanttChartSquare },
] as const
const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'

export function WbsWorkspace({ view, onChange, projectName, children, overlay, overlayOpen = false }: {
  view: WbsView
  onChange: (view: WbsView) => void
  projectName: string
  children: (fullscreen: boolean) => ReactNode
  overlay?: ReactNode
  overlayOpen?: boolean
}) {
  const [fullscreen, setFullscreen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const placeholder = useRef<HTMLDivElement>(null)
  const overlayWasOpen = useRef(false)
  const previousFocus = useRef<HTMLElement | null>(null)

  // Keep the same mounted views so entering fullscreen never discards an edit draft.
  useLayoutEffect(() => {
    if (!fullscreen || !root.current) return
    const panel = root.current
    const toggleButton = toggle.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const hidden: { element: HTMLElement; inert: boolean }[] = []
    const scrollPositions: { element: HTMLElement; top: number; left: number }[] = []
    let current: HTMLElement = panel
    while (current.parentElement) {
      const parent = current.parentElement
      scrollPositions.push({ element: parent, top: parent.scrollTop, left: parent.scrollLeft })
      for (const sibling of parent.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          hidden.push({ element: sibling, inert: sibling.inert })
          sibling.inert = true
        }
      }
      current = parent
    }
    const onKey = (event: KeyboardEvent) => {
      const dialog = panel.querySelector<HTMLElement>('[role="dialog"]')
      if (event.key === 'Escape' && !dialog) {
        event.preventDefault()
        setFullscreen(false)
      }
      if (event.key !== 'Tab') return
      const scope = dialog ?? panel
      const nodes = [...scope.querySelectorAll<HTMLElement>(focusable)]
        .filter((el) => el.getClientRects().length && !el.closest('[hidden], [inert]'))
      if (!nodes.length) return
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (!scope.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    toggleButton?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      hidden.forEach(({ element, inert }) => { element.inert = inert })
      scrollPositions.forEach(({ element, top, left }) => { element.scrollTop = top; element.scrollLeft = left })
      toggleButton?.focus({ preventScroll: true })
    }
  }, [fullscreen])

  useLayoutEffect(() => {
    if (fullscreen && overlayOpen && !overlayWasOpen.current) {
      previousFocus.current = document.activeElement as HTMLElement | null
      root.current?.querySelector<HTMLElement>('[role="dialog"] button')?.focus({ preventScroll: true })
    } else if (fullscreen && !overlayOpen && overlayWasOpen.current) {
      previousFocus.current?.focus({ preventScroll: true })
    }
    overlayWasOpen.current = overlayOpen
  }, [fullscreen, overlayOpen])

  const toggleFullscreen = () => {
    if (!fullscreen && root.current && placeholder.current) {
      placeholder.current.style.height = `${root.current.getBoundingClientRect().height}px`
    } else if (placeholder.current) {
      placeholder.current.style.height = ''
    }
    setFullscreen((value) => !value)
  }
  useLayoutEffect(() => {
    if (!fullscreen && placeholder.current) placeholder.current.style.height = ''
  }, [fullscreen])

  return (
    <div ref={placeholder}>
      <section ref={root} aria-label="WBS 工作区" className={cn('wbs-workspace', fullscreen && 'wbs-workspace--fullscreen')}>
        {fullscreen && <div className="text-sm font-semibold text-ink-900 truncate shrink-0" title={projectName}>{projectName} · WBS</div>}
        <div className="wbs-workspace-toolbar">
          <div className="flex items-center flex-wrap gap-3">
            <div className="inline-flex rounded-md border border-ink-300 bg-white p-0.5" role="group" aria-label="WBS 视图">
              {views.map(({ value, label, icon: Icon }) => (
                <button key={value} type="button" aria-pressed={view === value} onClick={() => onChange(value)}
                  className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors', view === value ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-700 hover:bg-ink-100')}>
                  <Icon className="w-3.5 h-3.5" />{label}
                </button>
              ))}
            </div>
            <button ref={toggle} type="button" onClick={toggleFullscreen} aria-pressed={fullscreen}
              title={fullscreen ? '退出全屏（Esc）' : '全屏查看当前 WBS 视图'}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-white px-3 py-2 text-xs font-medium text-brand-700 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              {fullscreen ? '退出全屏' : '全屏视图'}
            </button>
          </div>
          <span className="wbs-workspace-hint text-xs text-ink-500">系统严格三级：项目 → 子项目 → 任务（Lv3 下不可再建子节点）</span>
        </div>
        <div className="wbs-workspace-content">{children(fullscreen)}</div>
        {overlay}
      </section>
    </div>
  )
}
