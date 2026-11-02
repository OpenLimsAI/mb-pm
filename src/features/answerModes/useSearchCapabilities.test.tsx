import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchCapability } from './AnswerTools'
import { notifySearchConfigurationChanged, useSearchCapabilities } from './useSearchCapabilities'
import type { AnswerCapabilities } from './types'

const ready: AnswerCapabilities = { webSearch: { configured: true, provider: 'deepseek', message: '复用当前模型密钥' }, modes: ['auto', 'general', 'knowledge', 'web'] }
const unavailable: AnswerCapabilities = { ...ready, webSearch: { configured: false, provider: null, message: '当前模型不是 DeepSeek 官方服务，请切换模型。' } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
function Harness({ client, profileId, revision = 1 }: { client: { capabilities?(id?: string): Promise<AnswerCapabilities> }; profileId: string; revision?: number }) {
  return <SearchCapability value={useSearchCapabilities(client, profileId, revision)} />
}
beforeEach(() => localStorage.clear())

describe('profile-bound search capability state', () => {
  it('requests the selected profile and discards late readiness from a previous model', async () => {
    const first = deferred<AnswerCapabilities>(), second = deferred<AnswerCapabilities>()
    const client = { capabilities: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) }
    const view = render(<Harness client={client} profileId="official" />)
    await waitFor(() => expect(client.capabilities).toHaveBeenCalledWith('official'))
    view.rerender(<Harness client={client} profileId="third-party" />)
    await waitFor(() => expect(client.capabilities).toHaveBeenLastCalledWith('third-party'))
    await act(async () => second.resolve(unavailable))
    expect(screen.getByText(unavailable.webSearch.message)).toBeInTheDocument()
    await act(async () => first.resolve(ready))
    expect(screen.queryByText('DeepSeek 官方搜索已就绪')).not.toBeInTheDocument()
    expect(screen.getByText('联网搜索暂不可用')).toBeInTheDocument()
  })

  it('clears readiness on model revision changes, refreshes on focus, and rejects old focus results', async () => {
    const oldFocus = deferred<AnswerCapabilities>(), currentFocus = deferred<AnswerCapabilities>()
    const client = { capabilities: vi.fn().mockResolvedValueOnce(ready).mockReturnValueOnce(oldFocus.promise).mockReturnValueOnce(currentFocus.promise).mockResolvedValueOnce(unavailable) }
    const view = render(<Harness client={client} profileId="official" />)
    await screen.findByText('DeepSeek 官方搜索已就绪')
    fireEvent.focus(window)
    expect(screen.queryByText('DeepSeek 官方搜索已就绪')).not.toBeInTheDocument()
    await waitFor(() => expect(client.capabilities).toHaveBeenCalledTimes(2))
    fireEvent.focus(window)
    await waitFor(() => expect(client.capabilities).toHaveBeenCalledTimes(3))
    await act(async () => currentFocus.resolve(unavailable))
    await act(async () => oldFocus.resolve(ready))
    expect(screen.queryByText('DeepSeek 官方搜索已就绪')).not.toBeInTheDocument()
    view.rerender(<Harness client={client} profileId="official" revision={2} />)
    expect(screen.getByText('联网搜索状态待确认')).toBeInTheDocument()
    await waitFor(() => expect(client.capabilities).toHaveBeenCalledTimes(4))
    expect(screen.getByText(unavailable.webSearch.message)).toBeInTheDocument()
  })

  it('refreshes when a model is saved without broadcasting configuration or a key', async () => {
    const client = { capabilities: vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValue(ready) }
    render(<Harness client={client} profileId="official" />)
    await screen.findByText(unavailable.webSearch.message)
    act(() => notifySearchConfigurationChanged())
    await screen.findByText('DeepSeek 官方搜索已就绪')
    expect(localStorage.length).toBe(1)
    expect(localStorage.getItem('mberp:model-settings-change:v1')).toMatch(/^[0-9a-f-]{36}$/)
    fireEvent(window, new StorageEvent('storage', { key: 'mberp:model-settings-change:v1', newValue: 'change-notification' }))
    await waitFor(() => expect(client.capabilities).toHaveBeenCalledTimes(3))
    expect(client.capabilities.mock.calls.every(call => call.length === 1 && call[0] === 'official')).toBe(true)
  })

  it('keeps capability failures unknown and supports old clients without the optional endpoint', async () => {
    const client = { capabilities: vi.fn().mockRejectedValue(new Error('unavailable')) }
    const view = render(<Harness client={client} profileId="official" />)
    await waitFor(() => expect(client.capabilities).toHaveBeenCalled())
    expect(screen.getByText('联网搜索状态待确认')).toBeInTheDocument()
    view.rerender(<Harness client={{}} profileId="legacy" />)
    expect(screen.queryByText('DeepSeek 官方搜索已就绪')).not.toBeInTheDocument()
  })
})
