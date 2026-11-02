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

  it('keeps a failed job and its saved question available for page recovery', async () => {
    server.use(http.get(`*/api/v1/assistant/tasks/async-task/requests/${requestId}`, () => HttpResponse.json({ ...stored, status: 'failed', partial_content: '', error: '模型读取超时' })))
    const result = await assistantApi.getRequest!(task.id, requestId)
    expect(result).toMatchObject({ status: 'failed', question: stored.question, context: stored.context, error: '模型读取超时', diagnosticId: 'a'.repeat(32) })
  })
})
