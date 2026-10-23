import { beforeEach, describe, expect, it } from 'vitest'
import { createDemoClient } from './demo'
import { emptySolution } from './template'
import { docxBlob } from './export'

describe('knowledge solution preview persistence and workflow', () => {
  beforeEach(() => window.localStorage.clear())
  const make = (scope = 'person-a') => createDemoClient(scope, scope, '研发专家')

  it('persists edits while isolating accounts and rejects outdated saves', async () => {
    const client = make(), item = (await client.list())[0]
    const input = { ...item, title: '修改后的方案' }
    const saved = await client.save(item.id, input)
    expect((await make().get(item.id)).title).toBe('修改后的方案')
    expect(saved.revision).toBe(item.revision + 1)
    await expect(client.save(item.id, input)).rejects.toMatchObject({ status: 409 })
    expect((await make('person-b').get(item.id)).title).not.toBe('修改后的方案')
  })
  it('freezes a final version, creates a revision and publishes idempotently', async () => {
    const client = make(); let item = await client.create(emptySolution('验证方案'))
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
    expect(new TextDecoder().decode(data)).toContain('缓冲体系选择与验证方案')
  })
})
