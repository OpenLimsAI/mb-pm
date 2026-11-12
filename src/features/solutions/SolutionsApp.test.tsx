import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import type { KnowledgeSource, Solution, SolutionClient } from './types'

const seed = (): Solution => ({ id: 'one', title: '研发报告', projectName: '项目 A', productName: '研究制剂', ownerId: 'author', ownerName: '张研究员', status: 'draft', revision: 1, version: 1, updatedAt: '2026-10-23T10:00:00Z', sections: [{ id: 's1', title: '研究目标', content: '原始内容' }, { id: 's2', title: '验证安排', content: '保留条件' }], formula: [], references: [], reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true })
const source: KnowledgeSource = { id: 'paper-1', title: '研究资料甲', kind: 'paper', authors: '作者甲', date: '2026-10-23', projectName: '项目 A', tags: [], content: '原文中的研究条件与观察', locator: '方法章节', version: '1', url: '', updatedAt: '2026-10-23T10:00:00Z' }
function mockClient(initial = seed()) {
  let stored = structuredClone(initial)
  const client: SolutionClient = {
    trash: vi.fn(async () => []), remove: vi.fn(async () => {}), restore: vi.fn(async () => seed()),
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

function openAnswerSettings() { const toggle = screen.getByRole('button', { name: '回答设置' }); if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle) }
beforeEach(() => { localStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown'); localStorage.setItem('ks-writing-mode', 'split'); sessionStorage.clear() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('knowledge solution workspace', () => {
  it('sends auto by default and shows the actual knowledge response when source restrictions apply', async () => {
    const client = mockClient()
    vi.mocked(client.ask).mockImplementation(async (_id, input) => ({ id: 'routed-answer', question: input.question, content: '仅依据指定资料整理。', createdAt: '2026-11-01T10:00:00Z', mode: 'ai', requestedMode: input.answerMode, answerMode: 'knowledge', modeReason: '仅在本次指定资料范围内查证', references: [], context: input.context, scope: '指定资料' }))
    await mount(client)
    openAnswerSettings()
    expect(screen.getByRole('combobox', { name: '回答方式' })).toHaveValue('auto')
    const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement, origin = new URL(frame.src).origin
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'mberp:knowledge-library:ready', version: 1, preview: true } }))
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'mberp:knowledge-library:selection', version: 1, path: 'sources/paper.md', title: source.title } }))
    })
    fireEvent.click(screen.getByRole('button', { name: '加入问答范围' }))
    await screen.findByText(/已限定资料范围，本轮仅知识库/)
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '这些材料的最新进展是什么' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await screen.findByText('仅依据指定资料整理。')
    expect(client.ask).toHaveBeenCalledWith('one', expect.objectContaining({ answerMode: 'auto', sourceIds: ['paper-1'] }), expect.any(AbortSignal))
    expect(screen.getByText('知识库回答')).toBeInTheDocument()
    expect(screen.queryByText('已联网检索')).not.toBeInTheDocument()
  })

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
    fireEvent.click(screen.getByRole('button', { name: '撰写报告' }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('不能丢失的修改')
    expect(screen.getByRole('button', { name: '比较服务器版本' })).toBeInTheDocument()
  })

  it('fetches full knowledge text and requires confirmation before inserting with an undo', async () => {
    const client = mockClient(); await mount(client)
    const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
    const origin = new URL(frame.src).origin
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {source:frame.contentWindow, origin, data:{type:'mberp:knowledge-library:ready',version:1,preview:true}}))
      window.dispatchEvent(new MessageEvent('message', {source:frame.contentWindow, origin, data:{type:'mberp:knowledge-library:selection',version:1,path:'sources/paper.md',title:source.title}}))
    })
    fireEvent.click(screen.getByRole('button', { name: '引用到章节' }))
    const confirmDialog = await screen.findByRole('dialog', { name: '确认采纳 · 原文引用' })
    expect(client.getSource).toHaveBeenCalledWith('kb:sources/paper.md', 'one')
    expect(within(confirmDialog).getByRole('textbox')).toHaveValue(source.content)
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('原始内容')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '确认插入并保留引用' }))
    const textarea = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
    expect(textarea.value).toContain('原文中的研究条件与观察')
    expect(textarea.value).toMatch(/\[\[cite:[^\]]+\]\]/)
    fireEvent.change(textarea, { target: { value: `${textarea.value}\n人工后续判断` } })
    fireEvent.click(screen.getByRole('button', { name: '撤销插入' }))
    expect(textarea).toHaveValue('原始内容\n人工后续判断')
    expect(screen.queryByRole('button', { name: '删除引用1' })).not.toBeInTheDocument()
  })

  it('keeps editor content when each module is hidden and restored', async () => {
    const client = mockClient(); await mount(client)
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '折叠仍保留' } })
    fireEvent.click(screen.getByRole('button', { name: '收起撰写报告' }))
    expect(screen.queryByRole('textbox', { name: '章节正文' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '隐藏知识库资料' }))
    fireEvent.click(screen.getByRole('button', { name: '隐藏AI 研究助手' }))
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开撰写报告' }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('折叠仍保留')
    fireEvent.click(screen.getByRole('button', { name: '展开AI 研究助手' }))
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toBeInTheDocument()
  })

  it('removes report source management without fetching the retired source list', async () => {
    const client = mockClient(); await mount(client)
    expect(screen.queryByRole('tab', {name:'报告资料'})).not.toBeInTheDocument()
    expect(screen.queryByRole('button', {name:'添加资料'})).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', {name:'搜索知识资料'})).not.toBeInTheDocument()
    expect(client.sources).not.toHaveBeenCalled()
    expect(screen.getByTitle('原知识库资料')).toBeInTheDocument()
  })

  it('does not expose or request the author conversation when opened by a reviewer', async () => {
    const client = mockClient({ ...seed(), status: 'in_review', reviewerId: 'reviewer', canEdit: false }); await mount(client, 'reviewer')
    expect(client.history).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBeDisabled()
  })
  it('removes the formula editor while preserving stored bindings and clears a deleted citation binding on save', async () => {
    const initial = seed()
    initial.references = [{ id: 'ref-existing', sourceId: 'paper-1', title: source.title, excerpt: source.content, locator: '', sourceVersion: '1', sectionId: 's1' }]
    initial.formula = [{ id: 'formula-a', material: '候选物料', purpose: '', specification: '', amount: '', unit: '', basis: '', range: '', rationale: '', evidenceIds: ['ref-existing'], verification: 'pending' }]
    const client = mockClient(initial)
    await mount(client)
    expect(screen.queryByText('候选配方表')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '正文改写，配方数据保持' } })
    fireEvent.click(screen.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1))
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ formula: initial.formula }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: /本章节参考依据/ }))
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
    expect(client.ask).toHaveBeenCalledWith('one', expect.objectContaining({ sectionId: savedInput.sections[2].id }), expect.any(AbortSignal))
    expect(vi.mocked(client.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.ask).mock.invocationCallOrder[0])
    fireEvent.click(await screen.findByRole('button', { name: '插入报告' }))
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

  it('edits the chapter heading directly and keeps empty or cancelled drafts out of the saved document', async () => {
    const client = mockClient(); await mount(client)
    const body = screen.getByRole('textbox', { name: '章节正文' })
    const title = screen.getByRole('textbox', { name: '章节标题' })
    expect(screen.queryByRole('button', { name: '修改当前章节名称' })).not.toBeInTheDocument()
    fireEvent.change(title, { target: { value: '直接修改研究目标' } })
    fireEvent.blur(title)
    expect(screen.getByRole('button', { name: '打开章节：直接修改研究目标' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBe(body)
    expect(body).toHaveValue('原始内容')
    fireEvent.change(title, { target: { value: '   ' } })
    fireEvent.blur(title)
    expect(title).toHaveValue('直接修改研究目标')
    fireEvent.change(title, { target: { value: '取消这次修改' } })
    fireEvent.keyDown(title, { key: 'Escape' })
    fireEvent.blur(title)
    expect(title).toHaveValue('直接修改研究目标')
    fireEvent.click(screen.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(() => expect(client.save).toHaveBeenCalled())
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ sections: [expect.objectContaining({ title: '直接修改研究目标', content: '原始内容' }), expect.anything()] }))
  })

  it('renames a chapter through a validated dialog without changing its content and supports cancelling', async () => {
    const client = mockClient(); await mount(client)
    fireEvent.click(screen.getByRole('button', { name: '章节操作：研究目标' }))
    fireEvent.click(screen.getByRole('button', { name: '修改名称' }))
    const name = screen.getByRole('textbox', { name: '新章节名称' })
    expect(name).toHaveValue('研究目标'); expect(name).toHaveAttribute('maxLength', '200')
    fireEvent.change(name, { target: { value: '不保存的名称' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '打开章节：研究目标' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '章节操作：研究目标' }))
    fireEvent.click(screen.getByRole('button', { name: '修改名称' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新章节名称' }), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: '保存名称' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '新章节名称' }), { target: { value: '  修订研究目标  ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
    expect(screen.getByRole('button', { name: '打开章节：修订研究目标' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '修订研究目标' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('原始内容')
  })

  it('confirms deletion, preserves another chapter edits, and restores citation bindings after saving', async () => {
    const initial = seed()
    initial.references = [{ id: 'ref-a', sourceId: 'paper-1', title: '研究资料甲', excerpt: source.content, locator: source.locator, sourceVersion: '1', sectionId: 's1' }]
    initial.formula = [{ id: 'f1', material: '候选物料', purpose: '', specification: '', amount: '', unit: '', basis: '', range: '', rationale: '', evidenceIds: ['ref-a'], verification: 'confirmed' }]
    const client = mockClient(initial); await mount(client)
    // Keep role/visibility checks local to the part of the workspace being exercised.
    const editor = within(screen.getByRole('region', { name: '撰写报告' }))
    const outline = within(editor.getByRole('navigation', { name: '章节目录' }))
    const body = () => editor.getByRole('textbox', { name: '章节正文' })
    fireEvent.click(outline.getByRole('button', { name: '章节操作：研究目标' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '章节操作' })).getByRole('button', { name: '删除章节' }))
    expect(screen.getByRole('dialog', { name: '删除章节' })).toHaveTextContent('1 条专属引用')
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除章节' })).getByRole('button', { name: '取消' }))
    expect(body()).toHaveValue('原始内容')
    fireEvent.click(outline.getByRole('button', { name: '章节操作：研究目标' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '章节操作' })).getByRole('button', { name: '删除章节' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除章节' })).getByRole('button', { name: '确认删除章节' }))
    expect(outline.queryByRole('button', { name: '打开章节：研究目标' })).not.toBeInTheDocument()
    expect(body()).toHaveValue('保留条件')
    fireEvent.click(editor.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1))
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ references: [], formula: [expect.objectContaining({ evidenceIds: [], verification: 'pending' })] }))
    fireEvent.change(body(), { target: { value: '删除后补充的验证安排' } })
    fireEvent.click(screen.getByRole('button', { name: '撤销删除' }))
    expect(body()).toHaveValue('删除后补充的验证安排')
    fireEvent.click(outline.getByRole('button', { name: '打开章节：研究目标' }))
    expect(body()).toHaveValue('原始内容')
    fireEvent.click(editor.getByRole('button', { name: /本章节参考依据/ }))
    expect(editor.getByRole('button', { name: '删除引用1' })).toBeInTheDocument()
    fireEvent.click(editor.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(2))
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ references: initial.references, formula: [expect.objectContaining({ evidenceIds: ['ref-a'] })] }))
  })

  it('keeps the current chapter when another is removed, disables the last deletion, and clears undo on report switch', async () => {
    const client = mockClient(); await mount(client)
    fireEvent.click(screen.getByRole('button', { name: '章节操作：验证安排' }))
    fireEvent.click(screen.getByRole('button', { name: '删除章节' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除章节' }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('原始内容')
    fireEvent.click(screen.getByRole('button', { name: '章节操作：研究目标' }))
    expect(screen.getByRole('button', { name: '删除章节' })).toBeDisabled()
    expect(screen.getByText('报告至少保留一个章节，最后一章不能删除。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
    fireEvent.click(screen.getByRole('button', { name: '报告列表' }))
    fireEvent.click(screen.getByRole('button', { name: '第二个报告' }))
    await screen.findByRole('heading', { name: '第二个报告' })
    expect(screen.queryByRole('button', { name: '撤销删除' })).not.toBeInTheDocument()
  })

  it('does not resurrect a deleted chapter from an older save or send a queued question for it', async () => {
    const client = mockClient(); await mount(client)
    let resolveSave!: (value: Solution) => void
    vi.mocked(client.save).mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve }))
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '保存中的研究目标' } })
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '保留这次问题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '章节操作：研究目标' }))
    fireEvent.click(screen.getByRole('button', { name: '删除章节' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除章节' }))
    await act(async () => resolveSave({ ...seed(), revision: 2 }))
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: '打开章节：研究目标' })).not.toBeInTheDocument()
    expect(client.ask).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('保留这次问题')
    expect(client.save).toHaveBeenLastCalledWith('one', expect.objectContaining({ revision: 2, sections: [seed().sections[1]] }))
  })

  it('disables chapter mutations in reading mode and for a non-author even with a writable flag', async () => {
    const client = mockClient(); await mount(client)
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(screen.getByRole('button', { name: '章节操作：研究目标' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加章节' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '撰写' }))
    expect(screen.getByRole('button', { name: '章节操作：研究目标' })).toBeEnabled()
  })

  it('allows an invited editor to save writing without accessing the author AI history', async () => {
    const client = mockClient(); await mount(client, 'invited-editor')
    const body = screen.getByRole('textbox', { name: '章节正文' })
    expect(body).toBeEnabled(); expect(client.history).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    fireEvent.change(body, { target: { value: '协作者补充的实验条件' } })
    fireEvent.click(screen.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(() => expect(client.save).toHaveBeenCalledWith('one', expect.objectContaining({ sections: expect.arrayContaining([expect.objectContaining({ content: '协作者补充的实验条件' })]) })))
  })

  it('does not allow chapter editing by a non-author or addition beyond sixty chapters', async () => {
    const initial = seed(); initial.canEdit = false; initial.sections = Array.from({ length: 60 }, (_, index) => ({ id: `s${index}`, title: `章节${index}`, content: '' }))
    const client = mockClient(initial); await mount(client, 'reader')
    expect(screen.getByRole('button', { name: '章节操作：章节0' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加章节' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加章节' })).toHaveAttribute('title', '报告最多保留 60 个章节')
  })

  it('reads selected library evidence independently before citation and ignores a failed authorization', async () => {
    const client = mockClient(); await mount(client)
    const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
    const origin = new URL(frame.src).origin
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'mberp:knowledge-library:ready', version: 1, preview: true } }))
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'mberp:knowledge-library:selection', version: 1, path: 'sources/paper.md', title: 'Frame title', content: 'Untrusted frame content' } }))
    })
    expect(client.getSource).not.toHaveBeenCalled()
    vi.mocked(client.getSource).mockRejectedValueOnce(new Error('当前账号未开通知识库权限'))
    fireEvent.click(screen.getByRole('button', { name: '引用到章节' }))
    expect(await screen.findByText('当前账号未开通知识库权限')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '确认采纳 · 原文引用' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '引用到章节' }))
    const dialog = await screen.findByRole('dialog', { name: '确认采纳 · 原文引用' })
    expect(client.getSource).toHaveBeenLastCalledWith('kb:sources/paper.md', 'one')
    expect(within(dialog).getByRole('textbox')).toHaveValue(source.content)
  })

  it('does not apply a library read to a different report after switching', async () => {
    const client = mockClient(); await mount(client)
    let resolveSource!: (value: KnowledgeSource) => void
    vi.mocked(client.getSource).mockReturnValueOnce(new Promise(resolve => { resolveSource = resolve }))
    const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement, origin = new URL(frame.src).origin
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'mberp:knowledge-library:ready', version: 1, preview: true } }))
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin, data: { type: 'mberp:knowledge-library:selection', version: 1, path: 'sources/paper.md', title: '文献' } }))
    })
    fireEvent.click(screen.getByRole('button', { name: '引用到章节' }))
    fireEvent.click(screen.getByRole('button', { name: '报告列表' }))
    fireEvent.click(screen.getByRole('button', { name: '第二个报告' }))
    await screen.findByRole('heading', { name: '第二个报告' })
    await act(async () => resolveSource(source))
    expect(screen.queryByRole('dialog', { name: '确认采纳 · 原文引用' })).not.toBeInTheDocument()
  })

})
