import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ColumnResizer } from './ColumnResizer'
import { useColumnWidth } from '../../lib/useColumnWidth'

const key = 'test:column-width'
function Example({ onClick = () => {} }: { onClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const column = useColumnWidth({ storageKey: key, defaultWidth: 320, containerRef: ref })
  return <div ref={ref} onClick={onClick}>
    <output>{column.width}</output>
    <ColumnResizer label="调整名称列宽" width={column.width} minWidth={column.minWidth} maxWidth={column.maxWidth} onChange={column.setWidth} onReset={column.resetWidth} />
  </div>
}
function pointer(target: Element | Window, type: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  fireEvent(target, event)
}
describe('shared column resizing', () => {
  let available: number
  let measure: () => void
  beforeEach(() => {
    localStorage.removeItem(key)
    available = 1000
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => available)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { measure = callback }
      observe() {}
      disconnect() {}
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.removeItem(key); document.body.style.removeProperty('user-select'); document.body.style.removeProperty('cursor') })

  it('drag updates live width without clicking the row, commits only on release and restores on remount', () => {
    const click = vi.fn()
    const view = render(<Example onClick={click} />)
    const divider = screen.getByRole('separator', { name: '调整名称列宽' })
    pointer(divider, 'pointerdown', 320)
    pointer(window, 'pointermove', 450, 2)
    expect(divider).toHaveAttribute('aria-valuenow', '320')
    pointer(window, 'pointermove', 450)
    expect(divider).toHaveAttribute('aria-valuenow', '450')
    expect(localStorage.getItem(key)).toBeNull()
    fireEvent.click(divider)
    expect(click).not.toHaveBeenCalled()
    pointer(window, 'pointerup', 450)
    expect(localStorage.getItem(key)).toBe('450')
    expect(document.body.style.cursor).toBe('')
    view.unmount()
    render(<Example />)
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '450')
  })

  it('Esc cancels without exiting a parent fullscreen listener and restores existing selection styles', () => {
    const escape = vi.fn()
    window.addEventListener('keydown', escape)
    document.body.style.setProperty('user-select', 'text', 'important')
    render(<Example />)
    const divider = screen.getByRole('separator')
    pointer(divider, 'pointerdown', 320)
    pointer(window, 'pointermove', 470)
    fireEvent.keyDown(divider, { key: 'Escape' })
    expect(divider).toHaveAttribute('aria-valuenow', '320')
    expect(escape).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBeNull()
    expect(document.body.style.getPropertyValue('user-select')).toBe('text')
    window.removeEventListener('keydown', escape)
    document.body.style.removeProperty('user-select')
  })

  it('supports keyboard bounds, reset, viewport shrinking and re-expansion without destroying preference', () => {
    render(<Example />)
    const divider = screen.getByRole('separator')
    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true })
    expect(divider).toHaveAttribute('aria-valuenow', '368')
    fireEvent.keyDown(divider, { key: 'End' })
    expect(divider).toHaveAttribute('aria-valuenow', '720')
    available = 400
    act(() => measure())
    expect(divider).toHaveAttribute('aria-valuemax', '280')
    expect(divider).toHaveAttribute('aria-valuenow', '280')
    expect(localStorage.getItem(key)).toBe('720')
    available = 1000
    act(() => measure())
    expect(divider).toHaveAttribute('aria-valuenow', '720')
    fireEvent.keyDown(divider, { key: 'Home' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(divider).toHaveAttribute('aria-valuenow', '160')
    fireEvent.doubleClick(divider)
    expect(divider).toHaveAttribute('aria-valuenow', '320')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('cancels on pointercancel and cleans up an active drag when unmounted', () => {
    const view = render(<Example />)
    const divider = screen.getByRole('separator')
    pointer(divider, 'pointerdown', 320)
    pointer(window, 'pointermove', 600)
    pointer(window, 'pointercancel', 600)
    expect(divider).toHaveAttribute('aria-valuenow', '320')
    pointer(divider, 'pointerdown', 320)
    view.unmount()
    pointer(window, 'pointermove', 600)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('ignores malformed preferences and remains usable when storage throws', () => {
    localStorage.setItem(key, 'Infinity')
    render(<Example />)
    const divider = screen.getByRole('separator')
    expect(divider).toHaveAttribute('aria-valuenow', '320')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider).toHaveAttribute('aria-valuenow', '336')
  })
})
