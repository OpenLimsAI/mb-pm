import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import KnowledgeLibrary from './KnowledgeLibrary'
import { isLibraryLoginComplete, readLibraryMessage, validLibraryPath } from './libraryEmbed'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function mount(preview = true) {
  const onUse = vi.fn()
  render(<KnowledgeLibrary preview={preview} editable busy={false} canAsk onUse={onUse} scope={<p>问答范围</p>} />)
  const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
  const origin = new URL(frame.src).origin
  function message(type: string, extra = {}, overrides = {}) {
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: `mberp:knowledge-library:${type}`, version: 1, preview, ...extra }, ...overrides })))
  }
  return { frame, origin, message, onUse }
}

describe('original library embedding', () => {
  it('requires the exact frame and origin before showing the library or accepting a selection', () => {
    const { frame, message, onUse } = mount()
    message('ready', {}, { origin: 'https://untrusted.example' })
    message('ready', {}, { source: window })
    message('ready', { preview: false })
    expect(frame).not.toHaveClass('is-ready')
    message('ready')
    expect(frame).toHaveClass('is-ready')
    message('selection', { path: 'sources/../private.md', title: 'bad' })
    expect(screen.getByRole('button', { name: '引用到章节' })).toBeDisabled()
    message('selection', { path: 'sources/paper.md', title: '授权文献', content: 'never trusted' })
    fireEvent.click(screen.getByRole('button', { name: '引用到章节' }))
    expect(onUse).toHaveBeenCalledWith('sources/paper.md', 'cite')
    message('selection', { path: null })
    expect(screen.getByRole('button', { name: '引用到章节' })).toBeDisabled()
  })

  it('shows only the embedded library and resets its selection on refresh', () => {
    const { frame, message } = mount()
    expect(screen.queryByRole('tab', { name: '报告资料' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '添加资料' })).not.toBeInTheDocument()
    message('ready'); message('selection', { path: 'sources/paper.md', title: '文献' })
    expect(screen.getByRole('button', { name: '加入问答范围' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '刷新知识库' }))
    expect(screen.getByTitle('原知识库资料')).not.toBe(frame)
    expect(screen.getByRole('button', { name: '加入问答范围' })).toBeDisabled()
  })

  it('offers recovery when login, network or an older library prevents readiness', () => {
    vi.useFakeTimers(); const { frame } = mount()
    act(() => vi.advanceTimersByTime(8000))
    expect(screen.getByText('资料视图暂未加载')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '在新窗口打开知识库' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(screen.getByTitle('原知识库资料')).not.toBe(frame)
    expect(screen.queryByText('资料视图暂未加载')).not.toBeInTheDocument()
  })

  it('accepts a slow ready response and does not replace a successful load with a timeout', () => {
    vi.useFakeTimers()
    const { frame, message } = mount()
    act(() => vi.advanceTimersByTime(8000))
    message('ready')
    act(() => vi.advanceTimersByTime(16000))
    expect(frame).toHaveClass('is-ready')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('clears stale material on auth loss and ignores selections until readiness is restored', () => {
    vi.useFakeTimers()
    const { frame, message } = mount(false)
    message('ready')
    message('selection', { path: 'sources/private.md', title: '已选资料' })
    message('auth-required', { loginUrl: 'https://untrusted.example/' })
    expect(frame).not.toHaveClass('is-ready')
    expect(screen.queryByText('已选资料')).not.toBeInTheDocument()
    expect(screen.getByText('知识库登录状态需要恢复')).toBeInTheDocument()
    message('selection', { path: 'sources/private.md', title: '迟到的旧资料' })
    expect(screen.queryByText('迟到的旧资料')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '引用到章节' })).toBeDisabled()
    act(() => vi.advanceTimersByTime(8000))
    expect(screen.getByText('知识库登录状态需要恢复')).toBeInTheDocument()
    message('ready')
    expect(frame).toHaveClass('is-ready')
    expect(screen.getByRole('button', { name: '引用到章节' })).toBeDisabled()
  })

  it('distinguishes permissions from service outages and rejects unknown error reasons', () => {
    const { message } = mount(false)
    message('error', { reason: '<script>untrusted</script>' })
    expect(screen.getByText('正在打开原知识库…')).toBeInTheDocument()
    message('error', { reason: 'unavailable' })
    expect(screen.getByText('暂时无法连接知识库')).toBeInTheDocument()
    message('error', { reason: 'forbidden' })
    expect(screen.getByText('当前账号没有知识库访问权限')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复知识库登录' })).not.toBeInTheDocument()
  })

  it('allows top-level OAuth recovery when browser policy prevents the embedded IAM probe', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(window)
    const { origin, message } = mount(false)
    message('error', { reason: 'unavailable' })
    fireEvent.click(screen.getByRole('button', { name: '恢复知识库登录' }))
    expect(new URL(open.mock.calls[0][0] as string).origin).toBe(origin)
    expect(new URL(open.mock.calls[0][0] as string).pathname).toBe('/web/auth/login')
  })

  it('opens only the fixed OAuth continuation and requires the exact popup and origin to reload', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(window)
    const { frame, origin, message } = mount(false)
    message('auth-required', { loginUrl: 'https://untrusted.example/' })
    fireEvent.click(screen.getByRole('button', { name: '恢复知识库登录' }))
    const login = new URL(open.mock.calls[0][0] as string)
    expect(login.origin).toBe(origin)
    expect(login.pathname).toBe('/web/auth/login')
    expect(login.searchParams.get('returnTo')).toBe('/web/auth/report-return')
    expect(window.location.pathname).toBe('/')
    message('authenticated') // The library iframe cannot impersonate the login popup.
    message('authenticated', {}, { source: window, origin: 'https://untrusted.example' })
    message('authenticated', { version: 2 }, { source: window })
    expect(screen.getByTitle('原知识库资料')).toBe(frame)
    message('authenticated', {}, { source: window })
    const freshFrame = screen.getByTitle('原知识库资料')
    expect(freshFrame).not.toBe(frame)
    fireEvent.focus(window)
    expect(screen.getByTitle('原知识库资料')).toBe(freshFrame)
  })

  it('recovers on returning focus when opener messages are unavailable, without reloading ordinary focus', () => {
    vi.spyOn(window, 'open').mockReturnValue(window)
    const { frame, message } = mount(false)
    fireEvent.focus(window)
    expect(screen.getByTitle('原知识库资料')).toBe(frame)
    message('auth-required')
    fireEvent.click(screen.getByRole('button', { name: '恢复知识库登录' }))
    fireEvent.focus(window)
    const freshFrame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
    expect(freshFrame).not.toBe(frame)
    act(() => window.dispatchEvent(new MessageEvent('message', { source: freshFrame.contentWindow, origin: new URL(freshFrame.src).origin, data: { type: 'mberp:knowledge-library:ready', version: 1, preview: false } })))
    fireEvent.focus(window)
    expect(screen.getByTitle('原知识库资料')).toBe(freshFrame)
  })

  it('keeps the report open and offers retry when popups are blocked', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { frame, message } = mount(false)
    message('auth-required')
    fireEvent.click(screen.getByRole('button', { name: '恢复知识库登录' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请允许此站点弹出新窗口')
    expect(screen.getByTitle('原知识库资料')).toBe(frame)
    open.mockReturnValue(window)
    fireEvent.click(screen.getByRole('button', { name: '恢复知识库登录' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('passes the selected excerpt separately from a document identifier', () => {
    const { message, onUse } = mount()
    message('ready'); message('selection', { path: 'sources/paper.md', title: '文献', excerpt: '精确引用内容', locator: '结果段' })
    fireEvent.click(screen.getByRole('button', { name: '引用选中段落' }))
    expect(onUse).toHaveBeenCalledWith('sources/paper.md', 'cite', { excerpt: '精确引用内容', locator: '结果段' })
    message('selection', { path: 'sources/paper.md', title: '文献', excerpt: 'x'.repeat(4001), locator: '结果段' })
    expect(screen.queryByRole('button', { name: '引用选中段落' })).not.toBeInTheDocument()
  })

  it('navigates citations through only the trusted library frame after readiness', () => {
    const target = { id: 1, path: 'sources/paper.md', title: '原文', excerpt: '结果内容' }
    render(<KnowledgeLibrary preview editable busy={false} canAsk onUse={vi.fn()} scope={null} navigateTo={target} />)
    const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
    const send = vi.spyOn(frame.contentWindow!, 'postMessage')
    expect(send).not.toHaveBeenCalled()
    const origin = new URL(frame.src).origin
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'mberp:knowledge-library:ready', version: 1, preview: true } })))
    expect(send).toHaveBeenCalledWith({ type: 'mberp:knowledge-library:navigate', version: 1, path: target.path, title: target.title, excerpt: target.excerpt }, origin)
  })
})

it.each(['sources/../secret.md', 'sources//a.md', 'sources/a%2f.md', 'sources/a\\b.md', 'wisdom/private.md', 'sources/a\n.md', 'sources/a.pdf'])('rejects an unsafe source path %s', path => expect(validLibraryPath(path)).toBe(false))
it('rejects unknown protocol versions and a missing frame', () => {
  const event = new MessageEvent('message', { source: window, origin: 'https://kb.example', data: { type: 'mberp:knowledge-library:ready', version: 2 } })
  expect(readLibraryMessage(event, window, event.origin)).toBeNull()
  expect(readLibraryMessage(event, null, event.origin)).toBeNull()
  expect(isLibraryLoginComplete(event, null, event.origin)).toBe(false)
})
