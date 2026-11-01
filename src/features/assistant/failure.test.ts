import { AxiosError, AxiosHeaders } from 'axios'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/setup'
import { assistantApi, assistantFailure } from './client'
import type { TaskSummary } from './client'

const requestId = '00112233-4455-6677-8899-aabbccddeeff'
const task = { id: 'test-task', revision: 1 } as TaskSummary

describe('assistant diagnostic errors', () => {
  it.each([[422, '回答达到模型输出上限'], [503, '模型等待超时'], [503, '模型服务限流']])('keeps a safe server reason and diagnostic ID for %i', async (status, message) => {
    const id = 'a'.repeat(32)
    server.use(http.post('*/api/v1/assistant/tasks/test-task/messages', () => HttpResponse.json({ detail: `${message}（诊断编号：${id}）` }, { status, headers: { 'X-Assistant-Diagnostic-ID': id } })))
    await expect(assistantApi.send(task, { requestId, question: 'question', context: '' })).rejects.toThrow(`${message}（诊断编号：${id}）`)
  })

  it.each([['ECONNABORTED', '页面等待超时'], ['ERR_NETWORK', '页面与服务的连接中断']])('correlates client-side %s without echoing the payload', (code, message) => {
    const error = new AxiosError('SECRET URL AND KEY', code, { headers: new AxiosHeaders(), data: JSON.stringify({ request_id: requestId, question: 'SECRET QUESTION', context: 'SECRET PAPER' }) })
    const displayed = assistantFailure(error)
    expect(displayed.message).toContain(message)
    expect(displayed.message).toContain(requestId)
    expect(displayed.message).not.toContain('SECRET')
  })

  it('keeps a request ID when an edge proxy replaces the server response', () => {
    const error = new AxiosError('edge failure', 'ERR_BAD_RESPONSE', { headers: new AxiosHeaders(), data: JSON.stringify({ request_id: requestId, question: 'SECRET QUESTION' }) }, {}, { status: 502, statusText: 'Bad Gateway', data: { detail: 'UNTRUSTED EDGE BODY' }, headers: {}, config: { headers: new AxiosHeaders() } })
    const displayed = assistantFailure(error)
    expect(displayed.message).toContain(requestId)
    expect(displayed.message).not.toContain('UNTRUSTED')
    expect(displayed.message).not.toContain('SECRET')
  })

  it('does not display an unvalidated client-supplied ID', () => {
    const error = new AxiosError('SECRET', 'ECONNABORTED', { headers: new AxiosHeaders(), data: { request_id: 'SECRET' } })
    expect(assistantFailure(error).message).not.toContain('SECRET')
  })
})
