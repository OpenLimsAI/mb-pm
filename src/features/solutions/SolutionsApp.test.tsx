import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import type { KnowledgeSource, Solution, SolutionClient } from './types'

const seed = (): Solution => ({ id: 'one', title: '研发报告', projectName: '项目 A', productName: '研究制剂', ownerId: 'author', ownerName: '张研究员', status: 'draft', revision: 1, version: 1, updatedAt: '2026-10-23T10:00:00Z', sections: [{ id: 's1', title: '研究目标', content: '原始内容' }, { id: 's2', title: '验证安排', content: '保留条件' }], formula: [], references: [], reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true })
const source: KnowledgeSource = { id: 'paper-1', title: '研究资料甲', kind: 'paper', authors: '作者甲', date: '2026-10-23', projectName: '项目 A', tags: [], content: '原文中的研究条件与观察', locator: '方法章节', version: '1', url: '', updatedAt: '2026-10-23T10:00:00Z' }
function mockClient(initial = seed()) {
  let stored = structuredClone(initial)
  const client: SolutionClient = {
    list: vi.fn(async () => [structuredClone(stored), { ...seed(), id: 'two', title: '第二个报告' }]),
    get: vi.fn(async id => id === 'one' ? structuredClone(stored) : { ...seed(), id: 'two', title: '第二个报告' }),
    create: vi.fn(async input => ({ ...seed(), ...input, id: 'created' })),
    save: vi.fn(async (_id, input) => { stored = { ...stored, ...input, revision: input.revision + 1 }; return structuredClone(stored) }),
    review: vi.fn(async () => stored), versions: vi.fn(async () => []), reviewers: vi.fn(async () => [{ id: 'author', name: '张研究员' }]),
    sources: vi.fn(async () => [{ ...source, content: '' }]), getSource: vi.fn(async () => source), knowledgeStatus: vi.fn(async () => ({ configured: false, available: false, message: '尚未连接企业知识库' })),
    addSource: vi.fn(async input => ({ ...source, ...input })), ask: vi.fn(async (_id, input) => ({ id: 'answer-1', question: input.question, content: '依据甲的综合整理', createdAt: '2026-10-23T10:00:00Z', mode: 'retrieval' as const, references: [{ id: 'ref-1', sourceId: 'paper-1', title: '研究资料甲', excerpt: source.content, locator: '方法章节', sourceVersion: '1', sectionId: input.sectionId }], context: input.context, scope: '' })),
    history: vi.fn(async () => []), exportWord: vi.fn(async () => {}), publish: vi.fn(async () => source),
  }
  return client
}
async function mount(client: SolutionClient, userId = 'author') { render(<SolutionsApp client={client} userId={userId} userName="张研究员" preview />); await screen.findByRole('textbox', { name: '章节正文' }) }
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('knowledge solution workspace', () => {
  it('preserves newer typing while an earlier autosave is still in flight', async () => {
    const client = mockClient(); await mount(client)
    let resolveSave!: (value: Solution) => void
    vi.mocked(client.save).mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve }))
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '第一次修改' } })
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(client.save).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '保存途中继续编辑' } })
    await act(async () => resolveSave({ ...seed(), sections: [{ id: 's1', title: '研究目标', content: '第一次修改' }, seed().sections[1]], revision: 2 }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('保存途中继续编辑')
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ revision: 2, sections: expect.arrayContaining([expect.objectContaining({ content: '保存途中继续编辑' })]) }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('保存途中继续编辑')
  })

  it('keeps unsaved edits when switching fails because of a revision conflict', async () => {
    const client = mockClient(); await mount(client)
    vi.mocked(client.save).mockRejectedValue(Object.assign(new Error('版本冲突'), { status: 409 }))
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '不能丢失的修改' } })
    fireEvent.click(screen.getByRole('button', { name: '报告列表' }))
    fireEvent.click(screen.getByRole('button', { name: '第二个报告' }))
    await screen.findByText('当前修改尚未保存，已保留在编辑器中。请先重试保存或另存副本。')
    expect(client.get).not.toHaveBeenCalledWith('two')
    fireEvent.click(screen.getByRole('button', { name: '报告撰写' }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('不能丢失的修改')
    expect(screen.getByRole('button', { name: '比较服务器版本' })).toBeInTheDocument()
  })

  it('fetches full knowledge text and requires confirmation before inserting with an undo', async () => {
    const client = mockClient(); await mount(client)
    fireEvent.click(await screen.findByRole('button', { name: /研究资料甲.*查看原文/ }))
    const sourceDialog = await screen.findByRole('dialog', { name: '知识资料 · 原文预览' })
    expect(client.getSource).toHaveBeenCalledWith('paper-1', 'one')
    expect(within(sourceDialog).getByText('原文中的研究条件与观察')).toBeInTheDocument()
    fireEvent.click(within(sourceDialog).getByRole('button', { name: '引用到当前章节' }))
    const confirmDialog = screen.getByRole('dialog', { name: '确认采纳 · 原文引用' })
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('原始内容')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '确认插入并保留引用' }))
    const textarea = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
    expect(textarea.value).toContain('原文中的研究条件与观察')
    expect(textarea.value).toContain('[依据：研究资料甲 · 1 · 方法章节]')
    fireEvent.change(textarea, { target: { value: `${textarea.value}\n人工后续判断` } })
    fireEvent.click(screen.getByRole('button', { name: '撤销插入' }))
    expect(textarea).toHaveValue('原始内容\n人工后续判断')
    expect(screen.queryByRole('button', { name: '删除引用1' })).not.toBeInTheDocument()
  })

  it('keeps editor content while both main panes and knowledge subsections collapse', async () => {
    const client = mockClient(); await mount(client)
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '折叠仍保留' } })
    fireEvent.click(screen.getByRole('button', { name: '收起报告撰写' }))
    expect(screen.queryByRole('textbox', { name: '章节正文' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '收起知识与AI' }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('折叠仍保留')
    fireEvent.click(screen.getByRole('button', { name: '展开知识与AI' }))
    fireEvent.click(screen.getByRole('button', { name: /AI 研究助手/ }))
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /AI 研究助手/ }))
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toBeInTheDocument()
  })

  it('queries the backend for knowledge searches and does not treat a loading failure as no results', async () => {
    const client = mockClient(); await mount(client)
    await waitFor(() => expect(client.sources).toHaveBeenCalled())
    vi.mocked(client.sources).mockRejectedValueOnce(new Error('索引服务离线'))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索知识资料' }), { target: { value: '关键词' } })
    await waitFor(() => expect(client.sources).toHaveBeenCalledWith('关键词', ''))
    expect(await screen.findByText('资料加载失败：索引服务离线')).toBeInTheDocument()
  })

  it('does not expose or request the author conversation when opened by a reviewer', async () => {
    const client = mockClient({ ...seed(), status: 'in_review', reviewerId: 'reviewer', canEdit: false }); await mount(client, 'reviewer')
    expect(client.history).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBeDisabled()
  })
  it('binds formula evidence to adopted references and clears those bindings when a citation is deleted', async () => {
    const initial = seed()
    initial.formula = [{ id: 'formula-a', material: '候选物料', purpose: '', specification: '', amount: '', unit: '', basis: '', range: '', rationale: '', evidenceIds: [], verification: 'pending' }]
    const client = mockClient(initial)
    vi.mocked(client.getSource).mockResolvedValue({ ...source, locator: '' })
    await mount(client)
    fireEvent.click(await screen.findByRole('button', { name: /研究资料甲.*查看原文/ }))
    const sourceDialog = await screen.findByRole('dialog', { name: '知识资料 · 原文预览' })
    fireEvent.click(within(sourceDialog).getByRole('button', { name: '引用到当前章节' }))
    fireEvent.click(screen.getByRole('button', { name: '确认插入并保留引用' }))
    fireEvent.click(screen.getByRole('button', { name: '展开候选物料依据' }))
    const select = screen.getByLabelText('关联依据') as HTMLSelectElement
    expect(select.options.length).toBe(1)
    const referenceId = select.options[0].value
    expect(referenceId).not.toBe('paper-1')
    select.options[0].selected = true
    fireEvent.change(select)
    fireEvent.click(screen.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(() => expect(client.save).toHaveBeenCalled())
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ references: [expect.objectContaining({ id: referenceId, sourceId: 'paper-1', locator: '' })], formula: [expect.objectContaining({ evidenceIds: [referenceId] })] }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '删除引用1' }))
    fireEvent.click(screen.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(2))
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ references: [], formula: [expect.objectContaining({ evidenceIds: [] })] }))
  })

  it('persists a newly created chapter before sending its question', async () => {
    const client = mockClient(); await mount(client)
    fireEvent.click(screen.getByRole('button', { name: '添加章节' }))
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '新章节的相关依据' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(client.ask).toHaveBeenCalled())
    const savedInput = vi.mocked(client.save).mock.calls[0][1]
    expect(savedInput.sections).toHaveLength(3)
    expect(client.ask).toHaveBeenCalledWith('one', expect.objectContaining({ sectionId: savedInput.sections[2].id }))
    expect(vi.mocked(client.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.ask).mock.invocationCallOrder[0])
    fireEvent.click(await screen.findByRole('button', { name: '插入章节' }))
    expect(screen.getByRole('dialog', { name: '确认采纳 · 知识摘录' })).toBeInTheDocument()
  })

  it('retains the question and does not call AI when pending writing cannot be saved', async () => {
    const client = mockClient(); await mount(client)
    vi.mocked(client.save).mockRejectedValue(new Error('网络离线'))
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '新正文' } })
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '需要保留的问题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await screen.findByText('问答未完成：当前报告尚未保存，请先处理保存失败后再提问。')
    expect(client.ask).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('需要保留的问题')
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('新正文')
  })

})
