import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpResponse, http } from 'msw'
import { server } from '../../test/setup'
import { createNotesApi, createPortalNotesApi, createPreviewNotesClient, noteSourceUrl } from './client'
import { newNote } from './draft'

beforeEach(() => localStorage.clear())
describe('independent personal notes', () => {
  it('persists across clients and apps without touching legacy KB notes; isolates users', async () => {
    localStorage.setItem('kb-notes', 'legacy KB note')
    const a = createPreviewNotesClient('issuer:alice'), b = createPreviewNotesClient('issuer:bob')
    const draft = newNote({ title: '报告摘录', content: '原文与个人观察', sourceApp: 'solutions', sourceTitle: '报告 · 目标', sourceUrl: '/solutions?preview=1' })
    await a.create(draft.id, draft)
    const industry = createPreviewNotesClient('issuer:alice')
    expect((await industry.list()).items[0]).toMatchObject(draft)
    expect((await b.list()).total).toBe(0)
    expect(localStorage.getItem('kb-notes')).toBe('legacy KB note')
    expect(await a.create(draft.id, draft)).toMatchObject({ revision: 1 })
    expect((await a.list()).total).toBe(1)
  })
  it('protects edits from conflicts and supports reversible trash', async () => {
    const client = createPreviewNotesClient('alice'), draft = newNote({ title: '观察', content: '原文' })
    const old = await client.create(draft.id, draft), latest = await client.save(old, { ...draft, content: '最新思考' })
    await expect(client.save(old, { ...draft, content: '过时文本' })).rejects.toThrow('其他页面')
    await expect(client.trash(old)).rejects.toThrow('其他页面')
    const removed = await client.trash(latest)
    expect((await client.list()).total).toBe(0)
    expect((await client.list({ trashed: true })).items).toHaveLength(1)
    const restored = await client.restore(removed)
    expect(restored.content).toBe('最新思考')
    expect(restored.revision).toBe(4)
  })
  it('filters literal search, source and paginated records', async () => {
    const client = createPreviewNotesClient('alice')
    for (let i = 0; i < 52; i++) { const draft = newNote({ title: `观察${i}`, content: i === 3 ? '100%确定' : '待验证', sourceApp: i % 2 ? 'information' : 'manual' }); await client.create(draft.id, draft) }
    expect((await client.list()).items).toHaveLength(50)
    expect((await client.list({ offset: 50 })).items).toHaveLength(2)
    expect((await client.list({ search: '%' })).total).toBe(1)
    expect((await client.list({ sourceApp: 'information' })).total).toBe(26)
  })
  it('preserves unreadable data and editor content when storage fails', async () => {
    const storage = { getItem: vi.fn(() => 'broken data'), setItem: vi.fn() } as unknown as Storage
    const client = createPreviewNotesClient('alice', storage)
    await expect(client.create('a', newNote({ title: '新笔记', content: '保留' }))).rejects.toThrow('未被覆盖')
    expect(storage.setItem).not.toHaveBeenCalled()
    vi.mocked(storage.getItem).mockReturnValue('[]')
    vi.mocked(storage.setItem).mockImplementation(() => { throw new Error('quota') })
    await expect(client.create('a', newNote({ title: '新笔记', content: '保留' }))).rejects.toThrow('保留当前正文')
  })
  it.each(['javascript:alert(1)', '//evil.example', '/\\evil', 'https://user:pass@example.org', 'data:text/html,x'])('rejects unsafe source links %s', url => expect(noteSourceUrl(url)).toBeUndefined())
  it('sends owned note fields with credentials and converts API data', async () => {
    const id = crypto.randomUUID(), draft = newNote({ title: '行业摘录', content: '个人观察', sourceApp: 'information', sourceUrl: 'https://example.org' })
    server.use(http.post('*/api/v1/notes', async ({ request }) => {
      const body = await request.json()
      expect(body).toMatchObject({ id, source_app: 'information', content: '个人观察' })
      expect(body).not.toHaveProperty('owner_id')
      expect(request.credentials).toBe('include')
      return HttpResponse.json({ ...body as object, revision: 1, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z', deleted_at: null }, { status: 201 })
    }))
    expect(await createPortalNotesApi('portal-a').create(id, draft)).toMatchObject({ sourceApp: 'information', revision: 1 })
  })
  it.each(['portal', 'knowledge'] as const)('pins every %s operation to the opening identity', async mode => {
    const input = newNote({ title: '私人观察', content: '正文' })
    const note = { ...input, revision: 1, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', deletedAt: null }
    const requests: string[] = []
    const ownHeader = mode === 'portal' ? 'X-Notes-Portal-Identity' : 'X-Notes-Identity'
    const otherHeader = mode === 'portal' ? 'X-Notes-Identity' : 'X-Notes-Portal-Identity'
    server.use(http.all(/\/api\/v1\/notes(?:[/?].*)?$/, ({ request }) => {
      expect(request.headers.get(ownHeader)).toBe('opening-identity')
      expect(request.headers.has(otherHeader)).toBe(false)
      expect(request.credentials).toBe('include')
      requests.push(request.method)
      return HttpResponse.json(request.method === 'GET' && new URL(request.url).pathname.endsWith('/notes') ? { items: [], total: 0 } : note)
    }))
    const api = mode === 'portal' ? createPortalNotesApi('opening-identity') : createNotesApi('opening-identity')
    await api.list()
    await api.get!(input.id)
    await api.create(input.id, input)
    await api.save(note, input)
    await api.trash(note)
    await api.restore(note)
    await api.share!(note, true)
    expect(requests).toEqual(['GET', 'GET', 'POST', 'PUT', 'POST', 'POST', 'POST'])
  })
  it('never sends an unbound portal request when the verified identity is missing', async () => {
    server.use(http.post('*/api/v1/notes', ({ request }) => {
      expect(request.headers.get('X-Notes-Portal-Identity')).toBe('invalid')
      return HttpResponse.json({ detail: 'identity missing' }, { status: 403 })
    }))
    const draft = newNote({ title: '未确定身份的草稿', content: '保留正文' })
    await expect(createPortalNotesApi(undefined).create(draft.id, draft)).rejects.toThrow('登录账号已变化')
  })
})
