import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import type { Answer, AskInput, KnowledgeSource, Solution, SolutionClient } from './types'

const prefix = '前文。\n\n', suffix = '后文。', original = prefix + suffix
const seed = (id = 'one'): Solution => ({ id, title: id === 'one' ? '行内问答报告' : '第二个报告', projectName: '项目 A', productName: '研究制剂', ownerId: 'author', ownerName: '张研究员', status: 'draft', revision: 1, version: 1, updatedAt: '2026-10-23T10:00:00Z', sections: [{ id: 's1', title: '研究目标', content: id === 'one' ? original : '第二报告正文' }, { id: 's2', title: '验证安排', content: '其他章节正文' }], formula: [], references: [], reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true })
const source: KnowledgeSource = { id: 'paper-1', title: '相关文献', kind: 'paper', authors: '', date: '', projectName: '项目 A', tags: [], content: '文献证据原文', locator: '方法章节', version: '2', url: '', updatedAt: '2026-10-23T10:00:00Z' }
function answer(input: AskInput, id = 'answer-late'): Answer {
  return { id, question: input.question, content: `回答：${input.question}`, createdAt: '2026-10-23T10:00:00Z', mode: 'retrieval', context: input.context, scope: '全部授权资料', references: [{ id: `reference-${id}`, sourceId: source.id, title: source.title, excerpt: source.content, locator: source.locator, sourceVersion: source.version, sectionId: input.sectionId }] }
}
function mockClient() {
  const stored = new Map(['one', 'two'].map(id => [id, seed(id)]))
  let count = 0
  const client: SolutionClient = {
    trash: vi.fn(async () => []), remove: vi.fn(async () => {}), restore: vi.fn(async () => seed()),
    list: vi.fn(async () => structuredClone([...stored.values()])),
    get: vi.fn(async id => structuredClone(stored.get(id)!)),
    create: vi.fn(async input => ({ ...seed('created'), ...input })),
    save: vi.fn(async (id, input) => { const next = { ...stored.get(id)!, ...structuredClone(input), revision: input.revision + 1 }; stored.set(id, next); return structuredClone(next) }),
    review: vi.fn(async id => structuredClone(stored.get(id)!)), versions: vi.fn(async () => []), reviewers: vi.fn(async () => []),
    sources: vi.fn(async () => [source]), getSource: vi.fn(async () => source), knowledgeStatus: vi.fn(async () => ({ configured: false, available: false, message: '本地测试资料' })),
    addSource: vi.fn(async input => ({ ...source, ...input })), ask: vi.fn(async (_id, input) => answer(input, `answer-${++count}`)),
    history: vi.fn(async () => []), exportWord: vi.fn(async () => {}), publish: vi.fn(async () => source),
  }
  return client
}
async function mount(client = mockClient()) {
  render(<SolutionsApp client={client} userId="author" userName="张研究员" preview />)
  await screen.findByRole('textbox', { name: '章节正文' })
  return client
}
function segments() { return screen.getAllByRole('textbox', { name: /^章节正文/ }) as HTMLTextAreaElement[] }
function body() { return segments().map(input => input.value).join('') }
function cards() { return screen.queryAllByRole('region', { name: '正文 AI 问答' }) }
function insertCard(offset = prefix.length, segment = segments()[0]) {
  const value = segment.value.slice(0, offset) + '/' + segment.value.slice(offset)
  fireEvent.input(segment, { target: { value, selectionStart: offset + 1, selectionEnd: offset + 1 }, inputType: 'insertText', data: '/' })
  fireEvent.click(screen.getByRole('menuitem', { name: /AI 问答/ }))
  return cards().at(-1)!
}
function askCard(card: HTMLElement, question: string) {
  fireEvent.change(within(card).getByRole('textbox', { name: '想了解什么？' }), { target: { value: question } })
  fireEvent.click(within(card).getByRole('button', { name: '提问' }))
}
async function adopt(card: HTMLElement, content?: string) {
  fireEvent.click(await within(card).findByRole('button', { name: '采纳到报告' }))
  const dialog = screen.getByRole('dialog', { name: /^确认采纳/ })
  if (content !== undefined) fireEvent.change(within(dialog).getByRole('textbox', { name: '确认或改写内容' }), { target: { value: content } })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认插入并保留引用' }))
}
function deferAnswer(client: SolutionClient) {
  let resolve!: (value: Answer) => void
  vi.mocked(client.ask).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  return async () => { const input = vi.mocked(client.ask).mock.calls[0][1]; await act(async () => resolve(answer(input))) }
}
async function saveNow(client: SolutionClient) {
  const previous = vi.mocked(client.save).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '有修改 · 将自动保存' }))
  await waitFor(() => expect(client.save).toHaveBeenCalledTimes(previous + 1))
  await screen.findByRole('button', { name: '已保存到本机' })
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown'); localStorage.setItem('ks-writing-mode', 'split'); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('inline questions in the report editor', () => {
  it('requires edited confirmation at the card position and undoes acceptance without losing later typing', async () => {
    const client = await mount()
    const card = insertCard()
    expect(body()).toBe(original)
    fireEvent.click(within(card).getByRole('checkbox', { name: /附带本章正文/ }))
    askCard(card, '比较研究条件')
    await within(card).findByText('回答：比较研究条件')
    expect(client.ask).toHaveBeenCalledWith('one', expect.objectContaining({ question: '比较研究条件', sectionId: 's1', context: original }))
    expect(client.save).toHaveBeenCalledWith('one', expect.objectContaining({ sections: seed().sections, references: [] }))
    expect(body()).toBe(original)
    expect(screen.queryByRole('button', { name: '删除引用1' })).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: '采纳到报告' }))
    const dialog = screen.getByRole('dialog', { name: /^确认采纳/ })
    expect(body()).toBe(original)
    expect(within(dialog).getByRole('combobox', { name: '插入到本章问答卡片位置' })).toBeDisabled()
    fireEvent.change(within(dialog).getByRole('textbox', { name: '确认或改写内容' }), { target: { value: '专家核对后的结论' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认插入并保留引用' }))
    expect(cards()).toHaveLength(0)
    expect(body().startsWith(prefix)).toBe(true)
    expect(body().endsWith(suffix)).toBe(true)
    expect(body()).toContain('专家核对后的结论')
    expect(body()).toContain('[依据：相关文献 · 2 · 方法章节]')
    expect(body()).not.toContain('回答：比较研究条件')
    await saveNow(client)
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ references: [expect.objectContaining({ sourceId: source.id, sectionId: 's1', sourceVersion: '2', locator: '方法章节' })] }))
    const textarea = segments()[0]
    fireEvent.change(textarea, { target: { value: textarea.value + '\n人工后续判断' } })
    fireEvent.click(screen.getByRole('button', { name: '撤销插入' }))
    expect(body()).toBe(original + '\n人工后续判断')
    expect(screen.queryByRole('button', { name: '删除引用1' })).not.toBeInTheDocument()
    await saveNow(client)
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ references: [], sections: expect.arrayContaining([expect.objectContaining({ id: 's1', content: original + '\n人工后续判断' })]) }))
  })

  it('tracks multiple card positions through edits before, between and after the cards', async () => {
    await mount()
    const first = insertCard()
    fireEvent.change(segments()[0], { target: { value: '前文扩写。\n\n' } })
    fireEvent.change(segments()[1], { target: { value: '中间补充。\n\n结尾。' } })
    const second = insertCard('中间补充。\n\n'.length, segments()[1])
    expect(cards()).toHaveLength(2)
    fireEvent.change(segments()[2], { target: { value: '结尾人工修改。' } })
    askCard(second, '第二个位置的问题')
    await adopt(second, '第二处采纳')
    expect(cards()).toHaveLength(1)
    expect(body()).toMatch(/^前文扩写。\n\n中间补充。\n\n[\s\S]*第二处采纳[\s\S]*结尾人工修改。$/)
    askCard(first, '第一个位置的问题')
    await adopt(first, '第一处采纳')
    expect(cards()).toHaveLength(0)
    expect(body()).toMatch(/^前文扩写。\n\n[\s\S]*第一处采纳[\s\S]*中间补充。\n\n[\s\S]*第二处采纳[\s\S]*结尾人工修改。$/)
  })

  it('undoes the accepted block at its tracked position and preserves an identical later copy', async () => {
    const client = await mount()
    const card = insertCard()
    askCard(card, '需要人工采纳的结论')
    await adopt(card, '经过确认的结论')
    const accepted = body(), added = accepted.slice(prefix.length, accepted.length - suffix.length)
    expect(added).toContain('经过确认的结论')
    fireEvent.change(segments()[0], { target: { value: accepted + '\n复制留存：' + added } })
    fireEvent.change(segments()[0], { target: { value: '新增开头。\n' + body() } })
    fireEvent.click(screen.getByRole('button', { name: '撤销插入' }))
    expect(body()).toBe('新增开头。\n' + original + '\n复制留存：' + added)
    expect(screen.queryByRole('button', { name: '删除引用1' })).not.toBeInTheDocument()
    await saveNow(client)
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ references: [], sections: expect.arrayContaining([expect.objectContaining({ id: 's1', content: '新增开头。\n' + original + '\n复制留存：' + added })]) }))
  })

  it('inserts new same-position cards before or between existing cards according to the chosen segment', async () => {
    await mount()
    const old = insertCard(0)
    fireEvent.change(within(old).getByRole('textbox', { name: '想了解什么？' }), { target: { value: '原来的卡片' } })
    insertCard(0, segments()[0])
    expect(within(cards()[0]).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('')
    expect(within(cards()[1]).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('原来的卡片')
    fireEvent.change(within(cards()[0]).getByRole('textbox', { name: '想了解什么？' }), { target: { value: '新建的前卡片' } })
    insertCard(0, segments()[1])
    expect(cards().map(card => (within(card).getByRole('textbox', { name: '想了解什么？' }) as HTMLTextAreaElement).value)).toEqual(['新建的前卡片', '', '原来的卡片'])
    expect(body()).toBe(original)
  })

  it('preserves each chapter card and its question while changing chapters', async () => {
    await mount()
    const card = insertCard()
    fireEvent.change(within(card).getByRole('textbox', { name: '想了解什么？' }), { target: { value: '未发出的草稿问题' } })
    fireEvent.click(screen.getByRole('button', { name: '打开章节：验证安排' }))
    expect(body()).toBe('其他章节正文')
    expect(cards()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '打开章节：研究目标' }))
    expect(cards()).toHaveLength(1)
    expect(within(cards()[0]).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('未发出的草稿问题')
    expect(body()).toBe(original)
  })

  it('keeps a late answer in history after the card is dismissed without inserting it', async () => {
    const client = mockClient(), complete = deferAnswer(client)
    await mount(client)
    const card = insertCard()
    askCard(card, '等待中的问题')
    await waitFor(() => expect(client.ask).toHaveBeenCalledOnce())
    fireEvent.click(within(card).getByRole('button', { name: '移除问答卡片' }))
    await complete()
    expect(cards()).toHaveLength(0)
    expect(body()).toBe(original)
    expect(screen.getByText('回答：等待中的问题')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除引用1' })).not.toBeInTheDocument()
  })

  it('discards late card work after switching reports', async () => {
    const client = mockClient(), complete = deferAnswer(client)
    await mount(client)
    askCard(insertCard(), '上一报告问题')
    await waitFor(() => expect(client.ask).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '报告列表' }))
    fireEvent.click(screen.getByRole('button', { name: '第二个报告' }))
    await waitFor(() => expect(segments()[0]).toHaveValue('第二报告正文'))
    await complete()
    expect(body()).toBe('第二报告正文')
    expect(cards()).toHaveLength(0)
    expect(screen.queryByText('回答：上一报告问题')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除引用1' })).not.toBeInTheDocument()
  })

  it('retains the pending question and allows retry when opening another report fails', async () => {
    const client = mockClient(), complete = deferAnswer(client)
    await mount(client)
    askCard(insertCard(), '切换失败也保留的问题')
    await waitFor(() => expect(client.ask).toHaveBeenCalledOnce())
    vi.mocked(client.get).mockRejectedValueOnce(new Error('目标报告暂时无法打开'))
    fireEvent.click(screen.getByRole('button', { name: '报告列表' }))
    fireEvent.click(screen.getByRole('button', { name: '第二个报告' }))
    await screen.findByText('目标报告暂时无法打开')
    fireEvent.click(screen.getByRole('button', { name: '撰写报告' }))
    const card = cards()[0]
    expect(within(card).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('切换失败也保留的问题')
    expect(within(card).getByRole('alert')).toHaveTextContent('报告未能切换，上次提问已中断。问题已保留，请重试。')
    expect(within(card).getByRole('button', { name: '提问' })).toBeEnabled()
    askCard(card, '返回原报告后重新提问')
    await within(card).findByText('回答：返回原报告后重新提问')
    expect(client.ask).toHaveBeenLastCalledWith('one', expect.objectContaining({ question: '返回原报告后重新提问' }))
    await complete()
    expect(within(card).getByText('回答：返回原报告后重新提问')).toBeInTheDocument()
    expect(screen.queryByText('回答：切换失败也保留的问题')).not.toBeInTheDocument()
    expect(body()).toBe(original)
  })

  it('does not resurrect a deleted chapter or its card when the pending answer arrives', async () => {
    const client = mockClient(), complete = deferAnswer(client)
    await mount(client)
    askCard(insertCard(), '即将删除章节的问题')
    await waitFor(() => expect(client.ask).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '章节操作：研究目标' }))
    fireEvent.click(screen.getByRole('button', { name: '删除章节' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除章节' }))
    await complete()
    expect(body()).toBe('其他章节正文')
    expect(cards()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '打开章节：研究目标' })).not.toBeInTheDocument()
    await saveNow(client)
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ sections: [seed().sections[1]], references: [] }))
  })

  it('retains the question after save and answer failures and sends only after a successful save', async () => {
    const client = mockClient()
    vi.mocked(client.save).mockRejectedValueOnce(new Error('保存服务离线'))
    vi.mocked(client.ask).mockRejectedValueOnce(new Error('问答服务稍后重试'))
    await mount(client)
    const card = insertCard()
    askCard(card, '需要保留的问题')
    expect(await within(card).findByRole('alert')).toHaveTextContent('报告尚未保存')
    expect(client.ask).not.toHaveBeenCalled()
    expect(within(card).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('需要保留的问题')
    fireEvent.click(within(card).getByRole('button', { name: '提问' }))
    await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent('问答服务稍后重试'))
    expect(client.save).toHaveBeenCalledTimes(2)
    expect(vi.mocked(client.save).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(client.ask).mock.invocationCallOrder[0])
    expect(within(card).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('需要保留的问题')
    fireEvent.click(within(card).getByRole('button', { name: '提问' }))
    await within(card).findByText('回答：需要保留的问题')
    expect(client.ask).toHaveBeenCalledTimes(2)
    expect(body()).toBe(original)
  })

  it('does not send a removed card after an in-flight save finally succeeds', async () => {
    const client = mockClient()
    let finishSave!: (value: Solution) => void
    vi.mocked(client.save).mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve }))
    await mount(client)
    const card = insertCard()
    askCard(card, '保存中取消的问题')
    await waitFor(() => expect(client.save).toHaveBeenCalledOnce())
    expect(client.ask).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: '移除问答卡片' }))
    const input = vi.mocked(client.save).mock.calls[0][1]
    await act(async () => finishSave({ ...seed(), ...input, revision: input.revision + 1 }))
    expect(client.ask).not.toHaveBeenCalled()
    expect(cards()).toHaveLength(0)
    expect(body()).toBe(original)
  })

  it('offers an explicit whole-outline hide and restores the same chapters and editing state', async () => {
    await mount()
    const card = insertCard()
    fireEvent.change(within(card).getByRole('textbox', { name: '想了解什么？' }), { target: { value: '目录折叠不丢失' } })
    fireEvent.click(screen.getByRole('button', { name: '隐藏整个章节目录' }))
    expect(screen.queryByRole('navigation', { name: '章节目录' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: '调整章节目录宽度' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开章节目录' }))
    expect(screen.getByRole('navigation', { name: '章节目录' })).toBeVisible()
    expect(screen.getByRole('button', { name: '打开章节：研究目标' })).toBeVisible()
    expect(within(cards()[0]).getByRole('textbox', { name: '想了解什么？' })).toHaveValue('目录折叠不丢失')
    expect(body()).toBe(original)
  })
})
