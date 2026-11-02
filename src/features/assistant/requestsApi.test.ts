import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../test/setup'
import { assistantApi } from './client'
import type { TaskSummary } from './client'

const requestId = '00112233-4455-6677-8899-aabbccddeeff'
const task = { id: 'async-task', revision: 3 } as TaskSummary
const stored = { request_id: requestId, task_id: task.id, status: 'running', stage: 'generating', question: '分析培养因素', context: '参考资料', requested_mode: 'auto', data_sources: [], model_profile_id: 'enterprise', partial_content: '首先关注细胞活率。', error: '', diagnostic_id: 'a'.repeat(32), created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:00:01Z' }

describe('assistant request API', () => {
  it('submits a durable request and reads status independently of the long message endpoint', async () => {
    const accepted = vi.fn(async ({ request }: { request: Request }) => {
      expect(await request.json()).toMatchObject({ revision: 3, request_id: requestId, question: stored.question, model_profile_id: 'enterprise', answer_mode: 'auto' })
      return HttpResponse.json({ ...stored, status: 'queued', stage: 'queued', partial_content: '' }, { status: 202 })
    })
    server.use(
      http.post('*/api/v1/assistant/tasks/async-task/requests', accepted),
      http.get('*/api/v1/assistant/tasks/async-task/requests/active', () => HttpResponse.json({ request: stored })),
      http.get(`*/api/v1/assistant/tasks/async-task/requests/${requestId}`, () => HttpResponse.json(stored)),
    )
    expect(await assistantApi.submitRequest!(task, { requestId, question: stored.question, context: stored.context, modelProfileId: 'enterprise', answerMode: 'auto' })).toMatchObject({ requestId, status: 'queued', partialContent: '' })
    expect(await assistantApi.getRequest!(task.id, requestId)).toMatchObject({ requestId, partialContent: stored.partial_content, diagnosticId: 'a'.repeat(32), modelProfileId: 'enterprise', requestedMode: 'auto' })
    expect(await assistantApi.activeRequest!(task.id)).toMatchObject({ request: { requestId, taskId: task.id } })
    expect(accepted).toHaveBeenCalledTimes(1)
  })

  it('cancels an owned request and retains the server-labelled incomplete draft', async () => {
    server.use(http.post(`*/api/v1/assistant/tasks/async-task/requests/${requestId}/cancel`, () => HttpResponse.json({ ...stored, status: 'cancelled', can_continue: true, error_code: 'request_cancelled' })))
    expect(await assistantApi.cancelRequest!(task.id, requestId)).toMatchObject({ status: 'cancelled', canContinue: true, errorCode: 'request_cancelled', partialContent: stored.partial_content })
  })
  it('checks configuration without sending the attached private material', async () => {
    server.use(http.post('*/api/v1/assistant/tasks/preflight', async ({ request }) => {
      const body = await request.json()
      expect(body).toEqual({ task_id: task.id, model_profile_id: 'enterprise', answer_mode: 'auto', data_sources: ['knowledge'], reference_material_available: true })
      return HttpResponse.json({ ready: true, checks: [{ key: 'model', status: 'ready', message: '配置完整，尚未调用模型' }] })
    }))
    expect(await assistantApi.preflight!({ taskId: task.id, modelProfileId: 'enterprise', answerMode: 'auto', dataSources: ['knowledge'], referenceMaterialAvailable: true })).toMatchObject({ ready: true })
  })
  it('reads a bounded original source page and forwards continuation by owned request ID only', async () => {
    server.use(http.get('*/api/v1/assistant/tasks/async-task/sources', ({ request }) => {
      const url = new URL(request.url); expect(url.searchParams.get('path')).toBe('sources/paper.md'); expect(url.searchParams.get('offset')).toBe('8000')
      return HttpResponse.json({ title: '材料原文', path: 'sources/paper.md', body: '第二段正文', offset: 8000, total_chars: 9000, next_offset: null })
    }), http.post('*/api/v1/assistant/tasks/async-task/requests', async ({ request }) => {
      expect(await request.json()).toMatchObject({ continue_from_request: requestId }); return HttpResponse.json(stored, { status: 202 })
    }))
    expect(await assistantApi.getSource!(task.id, 'sources/paper.md', 8000)).toMatchObject({ body: '第二段正文', totalChars: 9000, nextOffset: null })
    await assistantApi.submitRequest!(task, { requestId: crypto.randomUUID(), question: '继续分析', context: '', continueFromRequest: requestId })
  })

  it('preserves queue-limit guidance rather than blaming model configuration', async () => {
    server.use(http.post('*/api/v1/assistant/tasks/async-task/requests', () => HttpResponse.json({ detail: '已有多项问题正在处理，请稍后再提交' }, { status: 429 })))
    await expect(assistantApi.submitRequest!(task, { requestId, question: '问题', context: '' })).rejects.toThrow('已有多项问题正在处理，请稍后再提交')
  })

  it('keeps a failed job and its saved question available for page recovery', async () => {
    server.use(http.get(`*/api/v1/assistant/tasks/async-task/requests/${requestId}`, () => HttpResponse.json({ ...stored, status: 'failed', partial_content: '', error: '模型读取超时' })))
    const result = await assistantApi.getRequest!(task.id, requestId)
    expect(result).toMatchObject({ status: 'failed', question: stored.question, context: stored.context, error: '模型读取超时', diagnosticId: 'a'.repeat(32) })
  })
})
