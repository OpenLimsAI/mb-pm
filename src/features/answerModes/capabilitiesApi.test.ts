import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../test/setup'
import { assistantApi } from '../assistant/client'
import { solutionApi } from '../solutions/api'

describe('selected-model capability API contract', () => {
  it('sends only model_profile_id from both assistants and never credentials', async () => {
    const queries: Record<string, string>[] = []
    server.use(http.get('*/api/v1/assistant/tasks/capabilities', ({ request }) => {
      queries.push(Object.fromEntries(new URL(request.url).searchParams))
      return HttpResponse.json({ web_search: { configured: true, provider: 'deepseek', message: '复用当前模型密钥' }, modes: ['auto', 'general', 'knowledge', 'web'] })
    }))
    expect(await assistantApi.capabilities!('enterprise')).toMatchObject({ webSearch: { configured: true, provider: 'deepseek' } })
    await assistantApi.capabilities!('private-model')
    await solutionApi.capabilities!('system')
    await solutionApi.capabilities!('retrieval')
    await assistantApi.capabilities!()
    expect(queries).toEqual([{ model_profile_id: 'enterprise' }, { model_profile_id: 'private-model' }, { model_profile_id: 'system' }, { model_profile_id: 'retrieval' }, {}])
  })

  it('keeps the safe 402 search balance explanation in research answers', async () => {
    server.use(http.post('*/api/v1/solutions/test-report/ask', () => HttpResponse.json({ detail: 'DeepSeek 搜索余额不足，请检查当前模型账户余额。' }, { status: 402 })))
    await expect(solutionApi.ask('test-report', { question: '最新研究', context: '', sourceIds: [], projectName: '', sectionId: 'one', modelProfileId: 'private-model', answerMode: 'web' })).rejects.toMatchObject({ status: 402, message: 'DeepSeek 搜索余额不足，请检查当前模型账户余额。' })
  })
})
