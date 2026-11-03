import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantPaneResizer from './AssistantPaneResizer'

let available = 1000
const storageKey = (scope = 'alice:live') => `assistant-pane-ratio:${scope}`
class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
}
function Harness({ disabled = false, scope = 'alice:live' }: { disabled?: boolean; scope?: string }) {
  const containerRef = useRef<HTMLDivElement>(null), conversationRef = useRef<HTMLElement>(null), resultRef = useRef<HTMLElement>(null)
  return <div className="aa-shell" data-testid="shell" ref={containerRef}>
    <nav />
    <main id="aa-chat" ref={conversationRef}>对话内容</main>
    <aside id="aa-result-pane" ref={resultRef}><AssistantPaneResizer key={scope} {...{ containerRef, conversationRef, resultRef, disabled, scope }} />结果内容</aside>
  </div>
}
function ratioInShell() {
  const style = screen.getByTestId('shell').style, first = Number.parseFloat(style.getPropertyValue('--aa-chat-weight')), second = Number.parseFloat(style.getPropertyValue('--aa-result-weight'))
  return Number.isFinite(first) ? first / (first + second) : 1 / (window.innerWidth <= 1150 ? 1.9 : 1.93)
}
function chatWidth() { return Math.max(window.innerWidth <= 1150 ? 330 : 360, Math.min(available - (window.innerWidth <= 1150 ? 310 : 340), available * ratioInShell())) }
function handle() { return screen.getByRole('separator', { name: '调整对话和结果区宽度' }) }
function begin() { const target = handle(); fireEvent.pointerDown(target, { pointerId: 7, button: 0, clientX: 700 }); return target }

beforeEach(() => {
  localStorage.clear(); available = 1000
  vi.stubGlobal('innerWidth', 1400)
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.id === 'aa-chat') return new DOMRect(228, 56, chatWidth(), 800)
    if (this.id === 'aa-result-pane') return new DOMRect(228 + chatWidth(), 56, available - chatWidth(), 800)
    return new DOMRect(0, 56, 228 + available, 800)
  })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('assistant pane resizing', () => {
  it('preserves the original desktop proportions and exposes keyboard controls', () => {
    render(<Harness />)
    expect(screen.getByTestId('shell').style.getPropertyValue('--aa-chat-weight')).toBe('')
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle()).toHaveAttribute('aria-controls', 'aa-chat aa-result-pane')
    expect(handle()).toHaveAttribute('tabindex', '0')
    expect(handle()).toHaveAttribute('aria-valuenow', '52')
    expect(localStorage.getItem(storageKey())).toBeNull()
  })

  it('drags both panes, clamps their widths, and remembers the final ratio', () => {
    render(<Harness />)
    const target = begin()
    expect(target.setPointerCapture).toHaveBeenCalledWith(7)
    expect(target).toHaveFocus()
    expect(screen.getByTestId('shell')).toHaveClass('aa-pane-resizing')
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 900 })
    expect(localStorage.getItem(storageKey())).toBeNull()
    expect(handle()).toHaveAttribute('aria-valuenow', '52')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 800 })
    expect(chatWidth()).toBeCloseTo(1000 / 1.93 + 100)
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 2000 })
    expect(chatWidth()).toBeCloseTo(660)
    expect(handle()).toHaveAttribute('aria-valuenow', '66')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 0 })
    expect(chatWidth()).toBe(360)
    fireEvent.pointerUp(window, { pointerId: 7 })
    expect(Number(localStorage.getItem(storageKey()))).toBe(.36)
    expect(target.releasePointerCapture).toHaveBeenCalledWith(7)
    expect(screen.getByTestId('shell')).not.toHaveClass('aa-pane-resizing')
    expect(document.querySelector('.aa-pane-resize-shield')).not.toBeInTheDocument()
  })

  it('supports arrows, larger shift steps, Home/End and double-click reset', () => {
    render(<Harness />)
    const initial = chatWidth()
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(chatWidth()).toBeCloseTo(initial + 16)
    fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true })
    expect(chatWidth()).toBeCloseTo(initial - 32)
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(chatWidth()).toBe(360)
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(chatWidth()).toBeCloseTo(660)
    fireEvent.doubleClick(handle())
    expect(chatWidth()).toBeCloseTo(initial)
    expect(localStorage.getItem(storageKey())).toBeNull()
  })

  it('restores preferences per identity and keeps preview separate', () => {
    localStorage.setItem(storageKey(), '.6')
    const view = render(<Harness />)
    expect(chatWidth()).toBe(600)
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    view.rerender(<Harness scope="bob:live" />)
    expect(chatWidth()).toBeCloseTo(1000 / 1.93)
    view.rerender(<Harness scope="alice:preview" />)
    expect(chatWidth()).toBeCloseTo(1000 / 1.93)
    view.rerender(<Harness />)
    expect(chatWidth()).toBeCloseTo(584)
  })

  it('constrains restored preferences for smaller windows without replacing the preference', () => {
    available = 2000
    localStorage.setItem(storageKey(), '.75')
    const view = render(<Harness />)
    expect(chatWidth()).toBe(1500)
    available = 800; vi.stubGlobal('innerWidth', 1100); fireEvent.resize(window)
    expect(chatWidth()).toBe(490)
    expect(handle()).toHaveAttribute('aria-valuenow', '61')
    // Both weights stay above one fr, so a minimum-constrained grid still fills the container.
    expect(screen.getByTestId('shell').style.getPropertyValue('--aa-chat-weight')).toBe('75fr')
    expect(screen.getByTestId('shell').style.getPropertyValue('--aa-result-weight')).toBe('25fr')
    view.rerender(<Harness disabled />)
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(localStorage.getItem(storageKey())).toBe('.75')
    available = 2000; vi.stubGlobal('innerWidth', 2400)
    view.rerender(<Harness />)
    expect(chatWidth()).toBe(1500)
  })

  it('keeps the medium-screen defaults and minimum widths', () => {
    available = 800; vi.stubGlobal('innerWidth', 1100)
    render(<Harness />)
    expect(chatWidth()).toBeCloseTo(800 / 1.9)
    fireEvent.keyDown(handle(), { key: 'Home' }); expect(chatWidth()).toBe(330)
    fireEvent.keyDown(handle(), { key: 'End' }); expect(chatWidth()).toBe(490)
  })

  it.each(['not-a-number', 'Infinity', '-0.4', '2', ''])('ignores invalid saved preference %j', saved => {
    localStorage.setItem(storageKey(), saved)
    render(<Harness />)
    expect(chatWidth()).toBeCloseTo(1000 / 1.93)
  })

  it('continues resizing when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    render(<Harness />)
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(chatWidth()).toBeCloseTo(660)
  })

  it.each(['disabled', 'narrow', 'unmount', 'blur', 'cancel', 'lostcapture'])('ends drag and removes listeners on %s', change => {
    const view = render(<Harness />), target = begin()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 760 })
    if (change === 'disabled') view.rerender(<Harness disabled />)
    else if (change === 'narrow') { vi.stubGlobal('innerWidth', 980); fireEvent.resize(window) }
    else if (change === 'unmount') view.unmount()
    else if (change === 'blur') fireEvent.blur(window)
    else if (change === 'cancel') fireEvent.pointerCancel(window, { pointerId: 7 })
    else fireEvent.lostPointerCapture(target, { pointerId: 7 })
    expect(document.querySelector('.aa-pane-resize-shield')).not.toBeInTheDocument()
    expect(document.querySelector('.aa-pane-resizing')).not.toBeInTheDocument()
    const saved = localStorage.getItem(storageKey())
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 1100 }); fireEvent.pointerUp(window, { pointerId: 7 })
    expect(localStorage.getItem(storageKey())).toBe(saved)
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')
  })

  it('cancels a drag with Escape and restores the prior preference', () => {
    localStorage.setItem(storageKey(), '.6')
    render(<Harness />); begin()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 640 })
    expect(chatWidth()).toBeCloseTo(540)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(chatWidth()).toBe(600)
    expect(localStorage.getItem(storageKey())).toBe('.6')
    expect(document.querySelector('.aa-pane-resize-shield')).not.toBeInTheDocument()
  })

  it('has no separator in the narrow drawer and enables it again on desktop', () => {
    vi.stubGlobal('innerWidth', 980)
    render(<Harness />)
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    act(() => { vi.stubGlobal('innerWidth', 1400); window.dispatchEvent(new Event('resize')) })
    expect(handle()).toBeInTheDocument()
  })
})
