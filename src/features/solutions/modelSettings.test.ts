import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../test/setup'
import { createModelSettingsClient, createPreviewModelClient, modelEndpointIdentity, modelProfileDraft, validateModelProfile } from './modelSettings'
import type { ModelProfileDraft } from './modelSettings'

const draft: ModelProfileDraft = { id: 'p1', name: '研究模型', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'configured-model' }
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('preview model settings', () => {
  it('persists multiple configurations and the default without secret or unexpected fields', async () => {
    const client = createPreviewModelClient('preview:author-1')
    const initial = await client.get()
    expect(initial).toEqual({ profiles: [], defaultProfileId: null, revision: 0 })
    const second = { ...draft, id: 'p2', name: '第二模型', provider: 'custom' as const, baseUrl: 'http://localhost:8000/v1' }
    const saved = await client.save({ profiles: [{ ...draft, keySet: true, injectedSecret: 'must-not-persist' } as ModelProfileDraft, second], defaultProfileId: 'p2', revision: 0 })
    expect(saved.profiles.map(profile => profile.keySet)).toEqual([false, false])
    expect(await createPreviewModelClient('preview:author-1').get()).toEqual(saved)
    const raw = localStorage.getItem(localStorage.key(0)!)!
    expect(raw).not.toContain('apiKey')
    expect(raw).not.toContain('api_key')
    expect(raw).not.toContain('must-not-persist')
    expect(raw).not.toContain('injectedSecret')
    expect(await createPreviewModelClient('preview:author-2').get()).toEqual(initial)
  })

  it('rejects secrets before writing and refuses model tests', async () => {
    const client = createPreviewModelClient('preview:author')
    await expect(client.save({ profiles: [{ ...draft, apiKey: 'private-api-key' }], defaultProfileId: 'p1', revision: 0 })).rejects.toThrow('不能保存真实 API 密钥')
    expect(localStorage.length).toBe(0)
    await expect(client.test(draft)).rejects.toThrow('预览不调用模型')
    expect(localStorage.length).toBe(0)
  })

  it('does not overwrite damaged existing data or silently report unavailable storage as saved', async () => {
    const key = 'ks-preview-model-settings:test', client = createPreviewModelClient('test')
    localStorage.setItem(key, '{broken')
    await expect(client.get()).rejects.toThrow('已有数据未被覆盖')
    await expect(client.save({ profiles: [draft], defaultProfileId: 'p1', revision: 0 })).rejects.toThrow('已有数据未被覆盖')
    expect(localStorage.getItem(key)).toBe('{broken')
    localStorage.clear()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    await expect(client.save({ profiles: [draft], defaultProfileId: 'p1', revision: 0 })).rejects.toThrow('当前草稿仍保留')
  })

  it('prevents stale edits, duplicate IDs and a missing default while permitting no-key metadata', async () => {
    const client = createPreviewModelClient('test')
    await client.save({ profiles: [draft], defaultProfileId: 'p1', revision: 0 })
    await expect(client.save({ profiles: [], defaultProfileId: null, revision: 0 })).rejects.toMatchObject({ status: 409 })
    await expect(client.save({ profiles: [draft, draft], defaultProfileId: 'p1', revision: 1 })).rejects.toThrow('响应无效')
    await expect(client.save({ profiles: [draft], defaultProfileId: 'missing', revision: 1 })).rejects.toThrow('默认模型配置无效')
    expect((await client.get()).profiles).toHaveLength(1)
    const saved = await client.save({ profiles: [{ ...draft, clearKey: true }], defaultProfileId: null, revision: 1 })
    expect(saved.profiles[0].keySet).toBe(false)
    expect(saved.defaultProfileId).toBeNull()
  })
})

describe('isolated model API transport', () => {
  it('uses portal credentials, snake_case payloads and whitelisted camelCase responses', async () => {
    let credentials = '', received: unknown
    server.use(
      http.get('*/api/v1/solutions/ai/settings', ({ request }) => { credentials = request.credentials; return HttpResponse.json({ profiles: [{ ...draft, baseUrl: undefined, base_url: draft.baseUrl, key_set: true, api_key: 'never-return-this' }], default_profile_id: 'p1', revision: 4 }) }),
      http.put('*/api/v1/solutions/ai/settings', async ({ request }) => { received = await request.json(); return HttpResponse.json({ profiles: [{ ...draft, base_url: draft.baseUrl, key_set: true }], default_profile_id: 'p1', revision: 5 }) }),
    )
    const client = createModelSettingsClient(), result = await client.get()
    expect(credentials).toBe('include')
    expect(result).toEqual({ profiles: [{ ...draft, keySet: true }], defaultProfileId: 'p1', revision: 4 })
    expect(JSON.stringify(result)).not.toContain('never-return-this')
    await client.save({ profiles: [{ ...draft, apiKey: 'new-key', keySet: true, unrelated: 'ignored' } as ModelProfileDraft], defaultProfileId: 'p1', revision: 4 })
    expect(received).toEqual({ profiles: [{ id: 'p1', name: draft.name, provider: 'deepseek', base_url: draft.baseUrl, model: draft.model, api_key: 'new-key' }], default_profile_id: 'p1', revision: 4 })
  })

  it('sends only a draft profile to the fixed server-side connection test', async () => {
    let received: unknown
    server.use(http.post('*/api/v1/solutions/ai/test', async ({ request }) => { received = await request.json(); return HttpResponse.json({ ok: false, model: draft.model, ms: 40, api_key: 'private' }) }))
    const result = await createModelSettingsClient().test({ ...draft, clearKey: true })
    expect(received).toEqual({ profile: { id: draft.id, name: draft.name, provider: draft.provider, base_url: draft.baseUrl, model: draft.model, clear_key: true } })
    expect(result).toEqual({ ok: false, model: draft.model, ms: 40 })
    expect(received).not.toHaveProperty('prompt')
  })

  it.each([401, 409, 422, 500])('removes provider error payloads and request credentials for status %s', async status => {
    const unauthorized = vi.fn()
    window.addEventListener('solutions:unauthorized', unauthorized)
    server.use(http.post('*/api/v1/solutions/ai/test', () => HttpResponse.json({ detail: 'Provider says Authorization: Bearer very-secret-key', api_key: 'other-key' }, { status })))
    const error = await createModelSettingsClient().test({ ...draft, apiKey: 'very-secret-key' }).catch(value => value as Error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('very-secret-key')
    expect(String(error)).not.toContain('other-key')
    expect(error).not.toHaveProperty('config')
    expect(error).not.toHaveProperty('response')
    expect(error).not.toHaveProperty('cause')
    expect(error).toHaveProperty('status', status)
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
    window.removeEventListener('solutions:unauthorized', unauthorized)
  })
})

it.each(['https://user:secret@example.test/v1', 'https://example.test/v1?api_key=secret', 'https://example.test/v1#secret', 'file:///private/key', 'not a URL'])('rejects credentials and invalid base URLs: %s', baseUrl => {
  expect(validateModelProfile({ ...draft, baseUrl })).not.toBeNull()
})
it('omits blank keys and key flags, rejects ambiguous key instructions and honors input limits', () => {
  expect(modelProfileDraft({ ...draft, apiKey: '', clearKey: false, keySet: true } as ModelProfileDraft)).toEqual(draft)
  expect(validateModelProfile({ ...draft, apiKey: 'new', clearKey: true })).toContain('选择一项')
  expect(validateModelProfile({ ...draft, apiKey: 'x'.repeat(2001) })).toContain('2,000')
  expect(validateModelProfile({ ...draft, model: '' })).toContain('模型名称')
  expect(validateModelProfile({ ...draft, apiKey: 'first\nsecond' })).toContain('换行')
})

it.each([
  [' HTTPS://MODEL.example/v1/ ', 'https://model.example/v1', true],
  ['https://model.example./v1///', 'https://model.example/v1', true],
  ['https://MODEL.example:443/v1/', 'https://model.example:443/v1', true],
  ['https://model.example:443/v1', 'https://model.example/v1', false],
  ['http://model.example:80/v1', 'http://model.example/v1', false],
  ['http://model.example/v1', 'https://model.example/v1', false],
  ['https://model.example/V1', 'https://model.example/v1', false],
  ['https://model.example/a/../v1', 'https://model.example/v1', false],
  ['https://model.example/%76%31', 'https://model.example/v1', false],
])('compares endpoint normalization conservatively: %s / %s', (left, right, equal) => {
  expect(modelEndpointIdentity(left) === modelEndpointIdentity(right)).toBe(equal)
})
