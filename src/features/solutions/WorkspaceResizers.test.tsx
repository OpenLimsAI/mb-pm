import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceResizers from './WorkspaceResizers'
import type { WorkspaceLayout, WorkspaceModule } from './layout'
import { defaultWorkspaceLayout } from './layout'
import { getSizedGrid, getStackHeight, getTrackSizes, sizeKey } from './workspaceSizing'
import type { WorkspaceSizes } from './workspaceSizing'

const all = { editor: true, knowledge: true, ai: true }
const empty = (): WorkspaceSizes => ({ desktop: {}, mobile: {} })
let measured = { layout: defaultWorkspaceLayout, visible: all, sizes: empty() }
class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId || 1 } }
const width = 1200, height = 800
function rectFor(element: HTMLElement): DOMRect {
  if (element.dataset.testid === 'workspace') return new DOMRect(100, 50, width, height)
  const module = element.dataset.module as WorkspaceModule | undefined
  if (!module || !measured.visible[module]) return new DOMRect()
  const parent = element.parentElement!, scroll = parent.scrollTop
  if (window.innerWidth <= 900) {
    const preceding = measured.layout.order.slice(0, measured.layout.order.indexOf(module)).filter(item => measured.visible[item])
    const top = preceding.reduce((sum, item) => sum + getStackHeight(item, measured.sizes) + 10, 0)
    return new DOMRect(100, 50 + top - scroll, width, getStackHeight(module, measured.sizes))
  }
  const tracks = getTrackSizes(measured.layout, measured.visible, measured.sizes)
  const cells = [...String(getSizedGrid(measured.layout, measured.visible, measured.sizes).gridTemplateAreas).matchAll(/"([^"]+)"/g)].map(match => match[1].split(' '))
  const slot = `s${measured.layout.order.indexOf(module) + 1}`
  const positions = cells.flatMap((row, y) => row.flatMap((value, x) => value === slot ? [{ x, y }] : []))
  const x1 = Math.min(...positions.map(point => point.x)), x2 = Math.max(...positions.map(point => point.x)), y1 = Math.min(...positions.map(point => point.y)), y2 = Math.max(...positions.map(point => point.y))
  const availableWidth = width - 7 * (tracks.columns.length - 1), availableHeight = height - 7 * (tracks.rows.length - 1)
  const left = tracks.columns.slice(0, x1).reduce((sum, value) => sum + value * availableWidth, 0) + x1 * 7
  const top = tracks.rows.slice(0, y1).reduce((sum, value) => sum + value * availableHeight, 0) + y1 * 7
  const spanWidth = tracks.columns.slice(x1, x2 + 1).reduce((sum, value) => sum + value * availableWidth, 0) + (x2 - x1) * 7
  const spanHeight = tracks.rows.slice(y1, y2 + 1).reduce((sum, value) => sum + value * availableHeight, 0) + (y2 - y1) * 7
  return new DOMRect(100 + left, 50 + top - scroll, spanWidth, spanHeight)
}
function Harness({ layout = defaultWorkspaceLayout, visible = all, disabled = false, initial = empty(), onChange = () => {} }: { layout?: WorkspaceLayout; visible?: typeof all; disabled?: boolean; initial?: WorkspaceSizes; onChange?: (sizes: WorkspaceSizes) => void }) {
  const containerRef = useRef<HTMLDivElement>(null), [sizes, setSizes] = useState(initial)
  useLayoutEffect(() => { measured = { layout, visible, sizes } }, [layout, visible, sizes])
  return <div className="ks-app"><div ref={containerRef} data-testid="workspace" className="ks-workspace ks-custom-workspace" style={{ ...getSizedGrid(layout, visible, sizes), gap: '7px' }}>
    {(['editor', 'knowledge', 'ai'] as WorkspaceModule[]).map(module => <section data-module={module} key={module} hidden={!visible[module]}>{module === 'knowledge' && <iframe title="Retained knowledge frame" />}</section>)}
    <WorkspaceResizers containerRef={containerRef} layout={layout} visible={visible} sizes={sizes} disabled={disabled} onChange={next => { setSizes(next); onChange(next) }} />
  </div><output data-testid="sizes">{JSON.stringify(sizes)}</output></div>
}
const result = (): WorkspaceSizes => JSON.parse(screen.getByTestId('sizes').textContent!)
async function mount(props: Parameters<typeof Harness>[0] = {}) { const view = render(<Harness {...props} />); if (!props.disabled && Object.values(props.visible || all).filter(Boolean).length > 1) await screen.findAllByRole('separator'); return view }

beforeEach(() => {
  measured = { layout: defaultWorkspaceLayout, visible: all, sizes: empty() }
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return rectFor(this) })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.removeProperty('user-select'); document.body.style.removeProperty('cursor') })

describe('measured workspace separators', () => {
  it.each(['columns', 'left-main', 'right-main', 'top-pair'] as const)('finds and merges the actual gaps for %s without remounting modules', async arrangement => {
    await mount({ layout: { ...defaultWorkspaceLayout, arrangement } })
    const handles = screen.getAllByRole('separator')
    expect(handles).toHaveLength(2)
    const vertical = handles.filter(handle => handle.getAttribute('aria-orientation') === 'vertical'), horizontal = handles.filter(handle => handle.getAttribute('aria-orientation') === 'horizontal')
    expect(vertical).toHaveLength(arrangement === 'columns' ? 2 : 1)
    expect(horizontal).toHaveLength(arrangement === 'columns' ? 0 : 1)
    if (arrangement === 'left-main' || arrangement === 'right-main') expect(vertical[0].style.height).toBe('800px')
    if (arrangement === 'top-pair') expect(horizontal[0].style.width).toBe('1200px')
    const frame = screen.getByTitle('Retained knowledge frame')
    fireEvent.keyDown(vertical[0], { key: 'ArrowRight' })
    expect(screen.getByTitle('Retained knowledge frame')).toBe(frame)
  })

  it('adjusts keyboard bounds with finite Home/End deltas and resets only the selected axis', async () => {
    await mount()
    const column = screen.getByRole('separator', { name: '调整模块列宽 1' }), row = screen.getByRole('separator', { name: '调整模块行高 1' })
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    const savedRows = result().desktop['left-main:111'].rows
    fireEvent.keyDown(column, { key: 'Home' })
    expect(column).toHaveAttribute('aria-valuenow', column.getAttribute('aria-valuemin'))
    expect(getTrackSizes(defaultWorkspaceLayout, all, result()).columns[0] * 1193).toBeCloseTo(240)
    fireEvent.keyDown(column, { key: 'End' })
    expect(column).toHaveAttribute('aria-valuenow', column.getAttribute('aria-valuemax'))
    expect(getTrackSizes(defaultWorkspaceLayout, all, result()).columns[1] * 1193).toBeCloseTo(240)
    fireEvent.doubleClick(column)
    expect(result().desktop['left-main:111'].columns).toBeUndefined()
    expect(result().desktop['left-main:111'].rows).toEqual(savedRows)
    const before = result()
    fireEvent.keyDown(column, { key: 'ArrowUp' })
    expect(result()).toEqual(before)
  })

  it('uses captured pointer deltas and restores temporary cursor, selection and iframe protection after release', async () => {
    const changed = vi.fn()
    await mount({ onChange: changed })
    const handle = screen.getByRole('separator', { name: '调整模块列宽 1' }), frame = screen.getByTitle('Retained knowledge frame'), container = screen.getByTestId('workspace')
    document.body.style.setProperty('cursor', 'crosshair', 'important'); document.body.style.userSelect = 'text'
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 700, clientY: 300 })
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7)
    expect(container).toHaveClass('ks-workspace-resizing')
    expect(document.body.style.userSelect).toBe('none')
    expect(container.querySelector('.ks-workspace-resize-shield')).toBeInTheDocument()
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 900, clientY: 300 })
    expect(changed).not.toHaveBeenCalled()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 800, clientY: 300 })
    expect(getTrackSizes(defaultWorkspaceLayout, all, result()).columns[0]).toBeCloseTo(.6 + 100 / 1193)
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 850, clientY: 300 })
    expect(getTrackSizes(defaultWorkspaceLayout, all, result()).columns[0]).toBeCloseTo(.6 + 150 / 1193)
    fireEvent.pointerUp(window, { pointerId: 7 })
    expect(container).not.toHaveClass('ks-workspace-resizing')
    expect(container.querySelector('.ks-workspace-resize-shield')).not.toBeInTheDocument()
    expect(document.body.style.userSelect).toBe('text')
    expect(document.body.style.cursor).toBe('crosshair')
    expect(screen.getByTitle('Retained knowledge frame')).toBe(frame)
    const calls = changed.mock.calls.length
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 900 })
    expect(changed).toHaveBeenCalledTimes(calls)
  })

  it.each(['disabled', 'visibility', 'layout', 'unmount'] as const)('cleans listeners and the drag shield when %s changes during a drag', async change => {
    const changed = vi.fn(), view = await mount({ onChange: changed })
    const handle = screen.getByRole('separator', { name: '调整模块列宽 1' })
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 700 })
    expect(document.body.style.userSelect).toBe('none')
    if (change === 'unmount') view.unmount()
    else if (change === 'disabled') view.rerender(<Harness disabled onChange={changed} />)
    else if (change === 'visibility') view.rerender(<Harness visible={{ ...all, knowledge: false }} onChange={changed} />)
    else view.rerender(<Harness layout={{ ...defaultWorkspaceLayout, arrangement: 'columns' }} onChange={changed} />)
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')
    expect(document.querySelector('.ks-workspace-resize-shield')).not.toBeInTheDocument()
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 1000 })
    expect(changed).not.toHaveBeenCalled()
    if (change !== 'unmount') { view.rerender(<Harness onChange={changed} />); await screen.findAllByRole('separator'); expect(document.querySelector('.ks-workspace-resize-shield')).not.toBeInTheDocument() }
  })

  it.each(['pointercancel', 'blur', 'lostcapture', 'escape'] as const)('restores drag state on %s', async event => {
    await mount()
    const handle = screen.getByRole('separator', { name: '调整模块列宽 1' })
    fireEvent.pointerDown(handle, { pointerId: 4, button: 0, clientX: 700 })
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 780 })
    if (event === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 4 })
    else if (event === 'blur') fireEvent.blur(window)
    else if (event === 'lostcapture') fireEvent.lostPointerCapture(handle, { pointerId: 4 })
    else fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.body.style.userSelect).toBe('')
    expect(document.querySelector('.ks-workspace-resize-shield')).not.toBeInTheDocument()
    if (event === 'escape') expect(result()).toEqual(empty())
  })

  it('redistributes stacked heights, honors Home/End, preserves other modules and does not drift on scroll', async () => {
    vi.stubGlobal('innerWidth', 800)
    await mount({ initial: { desktop: {}, mobile: { ai: 680 } } })
    const handle = screen.getByRole('separator', { name: '调整撰写报告与知识库资料的高度' }), originalTop = handle.style.top
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
    expect(handle).toHaveAttribute('aria-valuenow', '650')
    screen.getByTestId('workspace').scrollTop = 300
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(handle.style.top).toBe(originalTop))
    fireEvent.pointerDown(handle, { pointerId: 9, button: 0, clientY: 500 })
    fireEvent.pointerMove(window, { pointerId: 9, clientY: 600 })
    fireEvent.pointerUp(window, { pointerId: 9 })
    expect(result().mobile).toEqual({ editor: 750, knowledge: 420, ai: 680 })
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(result().mobile).toEqual({ editor: 240, knowledge: 930, ai: 680 })
    expect(handle).toHaveAttribute('aria-valuenow', '240')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(result().mobile).toEqual({ editor: 930, knowledge: 240, ai: 680 })
    expect(handle).toHaveAttribute('aria-valuenow', '930')
    fireEvent.doubleClick(handle)
    expect(result().mobile).toEqual({ ai: 680 })
    expect(sizeKey(defaultWorkspaceLayout, all)).toBe('left-main:111')
  })

  it('hides separators for a single visible module and focus mode without changing saved sizes', async () => {
    const initial: WorkspaceSizes = { desktop: { 'left-main:111': { columns: [.7, .3] } }, mobile: { editor: 800 } }
    const changed = vi.fn(), view = await mount({ initial, disabled: true, onChange: changed })
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
    view.rerender(<Harness initial={initial} visible={{ editor: true, knowledge: false, ai: false }} onChange={changed} />)
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
    expect(result()).toEqual(initial)
    expect(changed).not.toHaveBeenCalled()
  })
})
