import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoClient } from './demo'
import { emptySolution } from './template'
import { docxBlob } from './export'

describe('knowledge solution preview persistence and workflow', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())
  const make = (scope = 'person-a') => createDemoClient(scope, scope, '研发专家')

  it('previews polish without external calls or changing the saved report', async () => {
    const client = make(), report = (await client.list())[0]
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const result = await client.polish!(report.id, { sectionId: report.sections[0].id, text: '  条件,仍需验证 pH 5.5 和 10 mg [1]。  ', instruction: '更简洁' })
    expect(result).toEqual({ mode: 'preview', model: '本地文字整理演示', content: '条件，仍需验证 pH 5.5 和 10 mg [1]。' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await client.get(report.id)).toEqual(report)
    await expect(client.polish!(report.id, { sectionId: 'missing', text: '正文', instruction: '' })).rejects.toThrow('章节不存在')
  })

  it('persists edits while isolating accounts and rejects outdated saves', async () => {
    const client = make(), item = (await client.list())[0]
    const input = { ...item, title: '修改后的报告' }
    const saved = await client.save(item.id, input)
    expect((await make().get(item.id)).title).toBe('修改后的报告')
    expect(saved.revision).toBe(item.revision + 1)
    await expect(client.save(item.id, input)).rejects.toMatchObject({ status: 409 })
    expect((await make('person-b').get(item.id)).title).not.toBe('修改后的报告')
  })
  it('freezes a final version, creates a revision and publishes idempotently', async () => {
    const client = make(); let item = await client.create(emptySolution('验证报告'))
    item = await client.review(item.id, { action: 'submit', revision: item.revision, note: '提交作者确认' })
    item = await client.review(item.id, { action: 'approve', revision: item.revision, note: '作者确认，保留待验证项' })
    expect(item.canEdit).toBe(false)
    await expect(client.save(item.id, item)).rejects.toThrow('仅草稿')
    const first = await client.publish(item.id), second = await client.publish(item.id)
    expect(first.id).toBe(second.id)
    item = await client.review(item.id, { action: 'revise', revision: item.revision, note: '补充资料' })
    expect(item.version).toBe(2)
    expect(item.status).toBe('draft')
    expect((await client.versions(item.id)).some(v => v.snapshot.status === 'final')).toBe(true)
  })
  it('uses only selected evidence, saves question history and distinguishes no result', async () => {
    const client = make(), item = (await client.list())[0]
    const answer = await client.ask(item.id, { question: '缓冲体系实践', context: '当前章节', sourceIds: ['demo-practice'], projectName: '', sectionId: 'section-1' })
    expect(answer.mode).toBe('retrieval')
    expect(answer.references.map(ref => ref.sourceId)).toEqual(['demo-practice'])
    expect((await client.history(item.id))[0].id).toBe(answer.id)
    expect(await client.history((await client.create(emptySolution())).id)).toEqual([])
    const empty = await client.ask(item.id, { question: 'xyznonmatchingterm', context: '', sourceIds: ['demo-note'], projectName: '', sectionId: 'section-1' })
    expect(empty.references).toEqual([])
    expect(empty.content).toContain('未找到')
  })
  it('makes editable docx bytes rather than HTML with a Word extension', async () => {
    const item = (await make().list())[0]
    const blob = docxBlob(item)
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const data: ArrayBuffer = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob) })
    expect(Array.from(new Uint8Array(data).slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(new TextDecoder().decode(data)).toContain('word/document.xml')
    expect(new TextDecoder().decode(data)).toContain('缓冲体系选择与验证报告')
  })
  it('refreshes original-library previews and does not cite deleted cached documents in the all-sources scope', async () => {
    const client = make(), item = (await client.list())[0]
    const fixture = { ...(await client.sources())[0], id: 'kb:sources/demo-paper.md', kind: 'paper', title: '唯一测试材料', content: '唯一测试材料证据', locator: 'sources/demo-paper.md' }
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => fixture }))
    vi.stubGlobal('fetch', fetcher)
    await client.getSource(fixture.id)
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ credentials: 'omit' }))
    fetcher.mockResolvedValueOnce({ ok: false, status: 404 } as never)
    const answer = await client.ask(item.id, { question: '唯一测试材料', sourceIds: [], projectName: '', context: '', sectionId: item.sections[0].id })
    expect(answer.references.every(ref => ref.sourceId !== fixture.id)).toBe(true)
    expect((await client.sources()).some(source => source.id === fixture.id)).toBe(false)
    fetcher.mockResolvedValueOnce({ ok: false, status: 404 } as never)
    await expect(client.ask(item.id, { question: '材料', sourceIds: [fixture.id], projectName: '', context: '', sectionId: item.sections[0].id })).rejects.toThrow('已删除')
  })

})
