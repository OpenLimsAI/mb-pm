import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreviewAssistantClient } from './client'

const taskInput = (title = '研究任务') => ({ id: crypto.randomUUID(), title, project: '研发项目', instructions: '区分原文与待核实事项。' })
const question = (text = '请整理研究目标。') => ({ requestId: crypto.randomUUID(), question: text, context: '用户提供的阅读摘录。', modelProfileId: 'system' })
beforeEach(() => localStorage.clear())

describe('assistant preview persistence and private task conversations', () => {
  it('persists across reloads without changing other apps, and separates issuer/user namespaces', async () => {
    localStorage.setItem('kb-legacy-notes', 'keep KB notes')
    localStorage.setItem('mberp:personal-notes:preview:v1:issuer%3Aalice', 'keep independent notes')
    const alice = createPreviewAssistantClient('issuer:alice')
    const input = taskInput('Alice 的独立任务')
    const saved = await alice.create(input)
    const reloaded = createPreviewAssistantClient('issuer:alice')
    expect(await reloaded.get(saved.id)).toMatchObject({ ...input, messages: [], artifacts: [], messageCount: 0, revision: 1 })
    expect((await reloaded.list()).items.some(task => task.id === saved.id)).toBe(true)
    for (const namespace of ['issuer:bob', 'other-issuer:alice']) {
      const other = createPreviewAssistantClient(namespace)
      expect((await other.list()).items.some(task => task.id === saved.id)).toBe(false)
      await expect(other.get(saved.id)).rejects.toMatchObject({ status: 404 })
    }
    expect(localStorage.getItem('kb-legacy-notes')).toBe('keep KB notes')
    expect(localStorage.getItem('mberp:personal-notes:preview:v1:issuer%3Aalice')).toBe('keep independent notes')
  })

  it('deduplicates create retries and rejects UUID collisions with changed content', async () => {
    const client = createPreviewAssistantClient('owner'), input = taskInput('创建重试')
    const original = await client.create(input)
    expect(await client.create(input)).toEqual(original)
    expect((await client.list({ search: '创建重试' })).total).toBe(1)
    await expect(client.create({ ...input, instructions: '改变后的任务指引' })).rejects.toMatchObject({ status: 409 })
    expect(await client.get(input.id)).toEqual(original)
  })

  it('stores one user/assistant pair and one artifact per request and safely replays the exact request', async () => {
    const client = createPreviewAssistantClient('owner'), task = await client.create(taskInput())
    const input = question(), answered = await client.send(task, input)
    expect(answered).toMatchObject({ revision: 2, messageCount: 2 })
    expect(answered.messages).toHaveLength(2)
    expect(answered.messages[0]).toMatchObject({ role: 'user', content: input.question, context: input.context, model: 'system', requestId: input.requestId, mode: 'preview' })
    expect(answered.messages[1]).toMatchObject({ role: 'assistant', requestId: input.requestId, mode: 'preview' })
    expect(answered.artifacts).toHaveLength(1)
    expect(answered.artifacts[0].content).toBe(answered.messages[1].content)
    expect(await client.send(task, input)).toEqual(answered)
    await expect(client.send(answered, { ...input, question: '同一次请求却换了问题' })).rejects.toMatchObject({ status: 409 })
    await expect(client.send(answered, { ...input, modelProfileId: 'other-model' })).rejects.toMatchObject({ status: 409 })
    expect(await client.get(task.id)).toEqual(answered)
  })

  it('rejects stale sends, edits and trash operations without overwriting the latest work', async () => {
    const client = createPreviewAssistantClient('owner'), old = await client.create(taskInput())
    const latest = await client.save(old, { title: old.title, project: old.project, instructions: '最新任务指引' })
    await expect(client.save(old, { title: '过时修改', project: '', instructions: '' })).rejects.toMatchObject({ status: 409 })
    await expect(client.send(old, question())).rejects.toMatchObject({ status: 409 })
    await expect(client.trash(old)).rejects.toMatchObject({ status: 409 })
    expect(await client.get(old.id)).toEqual(latest)
  })

  it('keeps each task history and attached context separate while continuing the same task', async () => {
    const client = createPreviewAssistantClient('owner')
    const taskA = await client.create(taskInput('任务 A')), taskB = await client.create(taskInput('任务 B'))
    const first = question('任务 A 的第一问'), second = question('任务 A 的后续问题')
    first.context = '只属于 A 的原始材料。'; second.context = 'A 的第二份材料。'
    const a1 = await client.send(taskA, first), a2 = await client.send(a1, second)
    expect(a2.messages.filter(message => message.role === 'user').map(message => [message.content, message.context])).toEqual([[first.question, first.context], [second.question, second.context]])
    expect(a2.artifacts).toHaveLength(2)
    expect(a2.messages.at(-1)?.content).toContain('本地演示')
    expect(a2.messages.at(-1)?.content).toContain(taskA.instructions)
    expect(await client.get(taskB.id)).toMatchObject({ messages: [], artifacts: [], messageCount: 0 })
    expect((await client.list({ search: '任务 A' })).items[0].messageCount).toBe(4)
  })

  it('trashes and restores tasks with their complete history and prevents new messages while trashed', async () => {
    const client = createPreviewAssistantClient('owner'), created = await client.create(taskInput('可恢复任务'))
    const task = await client.send(created, question()), removed = await client.trash(task)
    expect(removed.deletedAt).not.toBeNull()
    expect((await client.list({ search: '可恢复任务' })).total).toBe(0)
    expect((await client.list({ trashed: true })).items.find(item => item.id === task.id)).toBeTruthy()
    await expect(client.send(removed, question('回收站里不应发送'))).rejects.toMatchObject({ status: 409 })
    await expect(client.restore(task)).rejects.toMatchObject({ status: 409 })
    const restored = await client.restore(removed)
    expect(restored.deletedAt).toBeNull()
    expect(restored.messages).toEqual(task.messages)
    expect(restored.artifacts).toEqual(task.artifacts)
    expect((await client.list({ search: '可恢复任务' })).items[0].id).toBe(task.id)
  })

  it('does not reset or overwrite malformed persisted task data', async () => {
    const storage = { getItem: vi.fn(() => '{malformed'), setItem: vi.fn() } as unknown as Storage
    const client = createPreviewAssistantClient('owner', storage)
    await expect(client.list()).rejects.toThrow('未被覆盖')
    await expect(client.create(taskInput())).rejects.toThrow('未被覆盖')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.getItem).toHaveReturnedWith('{malformed')
  })

  it('preserves stored data when browser quota prevents an answer being saved', async () => {
    let raw: string | null = null
    const write = vi.fn((_key: string, value: string) => { raw = value })
    const storage = { getItem: () => raw, setItem: write } as unknown as Storage
    const client = createPreviewAssistantClient('owner', storage), task = await client.create(taskInput())
    const before = raw
    write.mockImplementation(() => { throw new Error('quota exceeded') })
    await expect(client.send(task, question())).rejects.toThrow('保留当前问题')
    expect(raw).toBe(before)
    expect(await client.get(task.id)).toEqual(task)
  })

  it('checks question/context limits and prevents the report-only retrieval choice from sending', async () => {
    const client = createPreviewAssistantClient('owner'), task = await client.create(taskInput())
    for (const change of [{ question: ' ' }, { question: '问'.repeat(12001) }, { context: '文'.repeat(20001) }, { modelProfileId: 'retrieval' }]) {
      await expect(client.send(task, { ...question(), ...change })).rejects.toMatchObject({ status: 422 })
    }
    expect(await client.get(task.id)).toEqual(task)
  })
})
