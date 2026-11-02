import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useAssistantRequests from './useAssistantRequests'
import { createPreviewAssistantClient } from './client'
import type { AssistantClient, AssistantRequest, AssistantTask } from './client'

const id = 'a6f17d24-a1d1-4f29-bdcb-43f16d8c8499'
const task: AssistantTask = { id: 'task-a', title: '研究任务', instructions: '', revision: 1, messageCount: 0, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', deletedAt: null, messages: [], artifacts: [] }
const input = { requestId: id, question: '分析培养因素', context: '参考正文', answerMode: 'auto' as const }
const job = (patch: Partial<AssistantRequest> = {}): AssistantRequest => ({ requestId: id, taskId: task.id, status: 'queued', stage: 'queued', question: input.question, context: input.context, partialContent: '', error: '', diagnosticId: '', createdAt: task.createdAt, updatedAt: task.updatedAt, ...patch })
function setup() {
  const client: AssistantClient = { ...createPreviewAssistantClient(crypto.randomUUID()), submitRequest: vi.fn(async () => job()), getRequest: vi.fn(async () => job()), activeRequest: vi.fn(async () => ({ request: null })), get: vi.fn(async () => ({ ...task, revision: 2 })) }
  const callbacks = { restore: vi.fn(), complete: vi.fn(), fail: vi.fn() }
  return { client, callbacks }
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }
beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers() })

describe('durable assistant requests', () => {
  it('ignores an old delayed cancel response after a newer request has started', async () => {
    const { client, callbacks } = setup()
    let finish!: (record: AssistantRequest) => void
    client.cancelRequest = vi.fn(() => new Promise<AssistantRequest>(resolve => { finish = resolve }))
    const { result } = renderHook(() => useAssistantRequests(client, 'cancel-race:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    let cancellation!: Promise<void>
    act(() => { cancellation = result.current.cancel(task.id, id) })
    vi.mocked(client.getRequest!).mockResolvedValue(job({ status: 'cancelled' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    const nextId = 'b6f17d24-a1d1-4f29-bdcb-43f16d8c8499'
    vi.mocked(client.submitRequest!).mockResolvedValue(job({ requestId: nextId }))
    await act(async () => { await result.current.submit(task, { ...input, requestId: nextId }) })
    await act(async () => { finish(job({ status: 'cancelled' })); await cancellation })
    expect(result.current.progress[task.id].job?.requestId).toBe(nextId)
    expect(result.current.pending[task.id]).toBe(true)
  })
  it('does not restore retired input into the composer', async () => {
    const { client, callbacks } = setup()
    localStorage.setItem(`assistant-request:retired:live:${task.id}`, id)
    vi.mocked(client.getRequest!).mockResolvedValue(job({ status: 'failed', payloadExpired: true, question: '', context: '' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'retired:live', callbacks))
    act(() => result.current.resume(task.id)); await flush()
    expect(callbacks.restore).not.toHaveBeenCalled()
    expect(result.current.pending[task.id]).toBe(false)
  })

  it('settles a cancelled job without fetching final history or starting another generation', async () => {
    const { client, callbacks } = setup()
    client.cancelRequest = vi.fn(async () => job({ status: 'cancelled', canContinue: true, partialContent: '已保存的未完成草稿' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'cancel-owner:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    await act(async () => { await result.current.cancel(task.id, id) })
    expect(result.current.pending[task.id]).toBe(false)
    expect(result.current.progress[task.id].job?.status).toBe('cancelled')
    expect(result.current.progress[task.id].job?.partialContent).toBe('已保存的未完成草稿')
    expect(client.get).not.toHaveBeenCalled()
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(client.getRequest).not.toHaveBeenCalled()
  })
  it('discards protected partial text when cancellation recheck reports revoked access', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.submitRequest!).mockResolvedValue(job({ status: 'running', partialContent: '受保护的草稿' }))
    client.cancelRequest = vi.fn(async () => { throw Object.assign(new Error('权限已变更'), { status: 403 }) })
    vi.mocked(client.getRequest!).mockRejectedValue(Object.assign(new Error('权限已变更'), { status: 403 }))
    const { result } = renderHook(() => useAssistantRequests(client, 'cancel-owner:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    await act(async () => { await result.current.cancel(task.id, id) })
    expect(result.current.progress[task.id].job).toBeUndefined()
    expect(result.current.pending[task.id]).toBe(false)
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
  })

  it('polls one accepted request through partial generation and fetches saved history on completion', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.getRequest!).mockResolvedValueOnce(job({ status: 'running', stage: 'generating', partialContent: '已经生成的部分' })).mockResolvedValueOnce(job({ status: 'completed', stage: 'saving' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    expect(result.current.pending[task.id]).toBe(true)
    expect(localStorage.getItem(`assistant-request:user:live:${task.id}`)).toBe(id)
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(result.current.progress[task.id].job?.partialContent).toBe('已经生成的部分')
    expect(callbacks.restore).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(callbacks.complete).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }), expect.objectContaining({ status: 'completed' }))
    expect(result.current.pending[task.id]).toBeUndefined()
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`assistant-request:user:live:${task.id}`)).toBeNull()
  })

  it('restores a server-active request without browser state and never submits it again', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.activeRequest!).mockResolvedValue({ request: job({ status: 'running', stage: 'waiting_model' }) })
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    act(() => result.current.resume(task.id)); await flush()
    expect(result.current.pending[task.id]).toBe(true)
    expect(callbacks.restore).toHaveBeenCalledWith(expect.objectContaining({ question: input.question, context: input.context }))
    expect(client.submitRequest).not.toHaveBeenCalled()
  })

  it('recovers a remembered failed request after refresh and preserves its diagnostic and partial warning', async () => {
    const { client, callbacks } = setup()
    const failed = job({ status: 'failed', stage: 'generating', partialContent: '未完成内容', error: '模型读取超时', diagnosticId: 'a'.repeat(32) })
    localStorage.setItem(`assistant-request:user:live:${task.id}`, id)
    vi.mocked(client.getRequest!).mockResolvedValue(failed)
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    act(() => result.current.resume(task.id)); await flush()
    expect(result.current.pending[task.id]).toBe(false)
    expect(result.current.progress[task.id].job?.partialContent).toBe('未完成内容')
    expect(callbacks.fail).toHaveBeenCalledWith(task.id, expect.stringContaining('诊断编号：' + 'a'.repeat(32)), failed)
    expect(localStorage.getItem(`assistant-request:user:live:${task.id}`)).toBe(id)
    expect(client.submitRequest).not.toHaveBeenCalled()
  })

  it('keeps polling the same job after a network interruption, without another model submission', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.getRequest!).mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce(job({ status: 'completed' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(result.current.progress[task.id].phase).toBe('reconnecting')
    expect(result.current.pending[task.id]).toBe(true)
    expect(callbacks.fail).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(callbacks.complete).toHaveBeenCalledTimes(1)
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(client.getRequest!).mock.calls.every(args => args[1] === id)).toBe(true)
  })

  it('reads by the original ID when the POST response is lost and tolerates a commit race', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.submitRequest!).mockRejectedValue(new Error('connection reset'))
    vi.mocked(client.getRequest!).mockRejectedValueOnce(Object.assign(new Error('not yet saved'), { status: 404 })).mockResolvedValueOnce(job({ status: 'completed' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    expect(result.current.pending[task.id]).toBe(true)
    expect(callbacks.fail).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(callbacks.complete).toHaveBeenCalledTimes(1)
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
    expect(client.activeRequest).not.toHaveBeenCalled()
  })

  it('pauses on expired login, hides cached partial content and resumes on focus', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.submitRequest!).mockResolvedValue(job({ status: 'running', stage: 'generating', partialContent: '先前部分内容' }))
    vi.mocked(client.getRequest!).mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 })).mockResolvedValueOnce(job({ status: 'completed' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(result.current.progress[task.id]).toMatchObject({ phase: 'auth' })
    expect(result.current.progress[task.id].job).toBeUndefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(client.getRequest).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('focus'))); await flush()
    expect(callbacks.complete).toHaveBeenCalledTimes(1)
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps a completed job pending while saved-history retrieval reconnects', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.submitRequest!).mockResolvedValue(job({ status: 'completed' }))
    vi.mocked(client.get!).mockRejectedValueOnce(new Error('temporary disconnect')).mockResolvedValueOnce({ ...task, revision: 2 })
    vi.mocked(client.getRequest!).mockResolvedValue(job({ status: 'completed' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    expect(result.current.pending[task.id]).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(callbacks.complete).toHaveBeenCalledTimes(1)
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
  })

  it('stops retries and removes cached partial output after access is revoked', async () => {
    const { client, callbacks } = setup()
    vi.mocked(client.submitRequest!).mockResolvedValue(job({ status: 'running', partialContent: '旧的授权内容' }))
    vi.mocked(client.getRequest!).mockRejectedValue(Object.assign(new Error('no access'), { status: 403 }))
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(result.current.pending[task.id]).toBe(false)
    expect(result.current.progress[task.id].job).toBeUndefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(client.getRequest).toHaveBeenCalledTimes(1)
    expect(callbacks.fail).toHaveBeenCalledWith(task.id, 'no access', undefined)
  })

  it('does not clear a newer request pointer from another page when an older answer completes', async () => {
    const { client, callbacks } = setup()
    const newerId = crypto.randomUUID()
    vi.mocked(client.getRequest!).mockResolvedValue(job({ status: 'completed' }))
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    localStorage.setItem(`assistant-request:user:live:${task.id}`, newerId)
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(callbacks.complete).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`assistant-request:user:live:${task.id}`)).toBe(newerId)
  })

  it('attaches to a task already running in another page after a submit conflict', async () => {
    const { client, callbacks } = setup()
    const existing = job({ requestId: crypto.randomUUID(), status: 'running' })
    vi.mocked(client.submitRequest!).mockRejectedValue(Object.assign(new Error('already running'), { status: 409 }))
    vi.mocked(client.activeRequest!).mockResolvedValue({ request: existing })
    const { result } = renderHook(() => useAssistantRequests(client, 'user:live', callbacks))
    await act(async () => { await result.current.submit(task, input) })
    expect(result.current.pending[task.id]).toBe(true)
    expect(result.current.progress[task.id].job?.requestId).toBe(existing.requestId)
    expect(callbacks.fail).not.toHaveBeenCalled()
    expect(client.submitRequest).toHaveBeenCalledTimes(1)
  })

  it('ignores an old user namespace response arriving after the owner changes', async () => {
    const { client, callbacks } = setup()
    let resolve!: (value: AssistantRequest) => void
    vi.mocked(client.submitRequest!).mockImplementation(() => new Promise(r => { resolve = r }))
    const { result, rerender } = renderHook(({ namespace }) => useAssistantRequests(client, namespace, callbacks), { initialProps: { namespace: 'old-user:live' } })
    let submission!: Promise<void>
    act(() => { submission = result.current.submit(task, input) })
    rerender({ namespace: 'new-user:live' })
    await act(async () => { resolve(job({ status: 'completed' })); await submission })
    expect(callbacks.complete).not.toHaveBeenCalled()
    expect(result.current.progress).toEqual({})
  })
})
