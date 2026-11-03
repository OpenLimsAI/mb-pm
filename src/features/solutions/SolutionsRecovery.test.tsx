import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import type { Answer, KnowledgeSource, Solution, SolutionClient } from './types'
import { readWorkspaceRecovery, RECOVERY_TTL_MS, workspaceRecoveryScope, writeWorkspaceRecovery } from './workspaceRecovery'
import type { WorkspaceRecovery } from './workspaceRecovery'

const namespace = 'verified-issuer-subject-hash'
const scope = workspaceRecoveryScope(namespace, 'author', true)!
const seed = (): Solution => ({ id: 'r1', title: '研究现场恢复验证', projectName: '', productName: '', ownerId: 'author', ownerName: '研究员', status: 'draft', revision: 1, version: 1, updatedAt: '', sections: [{ id: 's1', title: '研究目标', content: '第一章正文' }, { id: 's2', title: '验证安排', content: '第二章正文' }], formula: [], references: [], reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true })
const paper: KnowledgeSource = { id: 'paper-1', title: '已授权论文', kind: 'paper', authors: '', date: '', projectName: '', tags: [], content: '证据内容', locator: '', version: '1', url: '', updatedAt: '' }
function mockClient(): SolutionClient {
  let stored = seed()
  return {
    list: vi.fn(async () => [structuredClone(stored)]), get: vi.fn(async () => structuredClone(stored)),
    create: vi.fn(async input => ({ ...seed(), ...input })), save: vi.fn(async (_id, input) => { stored = { ...stored, ...input, revision: input.revision + 1 }; return structuredClone(stored) }),
    trash: vi.fn(async () => []), remove: vi.fn(async () => {}), restore: vi.fn(async () => seed()), review: vi.fn(async () => seed()), versions: vi.fn(async () => []), reviewers: vi.fn(async () => []),
    sources: vi.fn(async () => [paper]), getSource: vi.fn(async () => paper), knowledgeStatus: vi.fn(async () => ({ available: true, configured: true, message: '' })), addSource: vi.fn(async () => paper),
    ask: vi.fn(async (_id, input): Promise<Answer> => ({ id: 'answer-1', conversationId: input.conversationId, question: input.question, content: '服务器已保存回答', references: [], context: input.context, scope: '', mode: 'ai', createdAt: '' })),
    history: vi.fn(async () => []), exportWord: vi.fn(async () => {}), publish: vi.fn(async () => paper),
  }
}
const cached = (): WorkspaceRecovery => ({ reportId: 'r1', sectionId: 's2', topicId: 'topic-1', question: '未发送的问题', context: '待核对的上下文', showContext: true, topicDrafts: { 'topic-2': { question: '另一主题草稿', context: '另一上下文', showContext: true } }, selectedSourceIds: ['paper-1'], projectFilter: '', inlineCards: [], interrupted: false, pendingTopicId: '', listOpen: false })
function app(client: SolutionClient, ns = namespace) { return <SolutionsApp client={client} userId="author" userName="研究员" preview recoveryNamespace={ns} initialHome /> }
async function open(client: SolutionClient) {
  const view = render(app(client))
  fireEvent.click(await screen.findByRole('button', { name: '研究现场恢复验证' }))
  await screen.findByRole('textbox', { name: '章节正文' })
  return view
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown'); sessionStorage.clear(); vi.restoreAllMocks() })
afterEach(() => { vi.useRealTimers() })

describe('research workspace survives authentication remounts', () => {
  it('silently restores chapter and source preferences without claiming that a question was recovered', async () => {
    writeWorkspaceRecovery(scope, { ...cached(), question: '', topicDrafts: {}, context: '已选章节正文', inlineCards: [] })
    const client = mockClient()
    render(app(client))
    await screen.findByRole('textbox', { name: '章节正文' })
    await waitFor(() => expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('第二章正文'))
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('')
    expect(screen.queryByText(/已恢复/)).not.toBeInTheDocument()
    expect(client.ask).not.toHaveBeenCalled()
  })

  it('briefly announces a recovered question without clearing the question when the notice disappears', async () => {
    writeWorkspaceRecovery(scope, { ...cached(), selectedSourceIds: [] })
    vi.useFakeTimers()
    await act(async () => { render(app(mockClient())) })
    expect(screen.getByText('已恢复未发送的问题，可继续编辑。')).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.queryByText('已恢复未发送的问题，可继续编辑。')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('未发送的问题')
    expect(readWorkspaceRecovery(scope)?.question).toBe('未发送的问题')
  })

  it('does not replace an unsaved report warning with a generic workspace recovery notice', async () => {
    writeWorkspaceRecovery(scope, { ...cached(), selectedSourceIds: [] })
    const unsaved = { ...seed(), sections: [{ id: 's1', title: '研究目标', content: '尚未保存的正文' }] }
    sessionStorage.setItem(`ks-draft:preview:${scope}:r1`, JSON.stringify(unsaved))
    render(app(mockClient()))
    await screen.findByRole('textbox', { name: '章节正文' })
    expect(screen.getByText('已恢复本机未保存草稿，请核对内容并保存。')).toBeVisible()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('尚未保存的正文')
    expect(screen.queryByText('已恢复未发送的问题，可继续编辑。')).not.toBeInTheDocument()
  })

  it.each(['general', 'knowledge', 'web'] as const)('restores the %s restriction after authentication without automatically sending the draft', async answerMode => {
    const client = mockClient(), view = await open(client)
    fireEvent.change(screen.getByRole('combobox', { name: '回答方式' }), { target: { value: answerMode } })
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '最新研究进展是否完整？' } })
    expect(readWorkspaceRecovery(scope)?.answerMode).toBe(answerMode)
    view.unmount()
    render(app(client))
    await screen.findByRole('textbox', { name: '向AI提问' })
    expect(screen.getByRole('combobox', { name: '回答方式' })).toHaveValue(answerMode)
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('最新研究进展是否完整？')
    expect(client.ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(client.ask).toHaveBeenCalledWith('r1', expect.objectContaining({ answerMode, question: '最新研究进展是否完整？' }), expect.any(AbortSignal)))
  })

  it('restores the active report, chapter, question, context and separate topic drafts without model requests', async () => {
    const client = mockClient(), view = await open(client)
    fireEvent.click(screen.getByRole('button', { name: '打开章节：验证安排' }))
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '登录前正在写的问题' } })
    fireEvent.click(screen.getByRole('button', { name: '不附带正文' }))
    fireEvent.change(screen.getByRole('textbox', { name: '附带上下文' }), { target: { value: '重新登录后仍需保留的上下文' } })
    const originalTopic = (screen.getByRole('combobox', { name: '对话主题' }) as HTMLSelectElement).value
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '另一研究主题的草稿' } })
    view.unmount()
    render(app(client))
    await screen.findByRole('textbox', { name: '章节正文' })
    expect(client.get).toHaveBeenLastCalledWith('r1')
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('第二章正文')
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('另一研究主题的草稿')
    fireEvent.change(screen.getByRole('combobox', { name: '对话主题' }), { target: { value: originalTopic } })
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('登录前正在写的问题')
    expect(screen.getByRole('textbox', { name: '附带上下文' })).toHaveValue('重新登录后仍需保留的上下文')
    expect(client.ask).not.toHaveBeenCalled()
  })

  it('never automatically retries an interrupted request and retrieves completed answers only from the server', async () => {
    const client = mockClient(), view = await open(client)
    let finish!: (answer: Answer) => void
    vi.mocked(client.ask).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '中断时的问题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1))
    const input = vi.mocked(client.ask).mock.calls[0][1]
    const answer: Answer = { id: 'answer-1', conversationId: input.conversationId, question: input.question, content: '已由服务器保存的回答', references: [], context: input.context, scope: '', mode: 'ai', createdAt: '' }
    expect(readWorkspaceRecovery(scope)?.interrupted).toBe(true)
    view.unmount()
    vi.mocked(client.history).mockResolvedValue([answer])
    render(app(client))
    await screen.findByText('已由服务器保存的回答')
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('中断时的问题')
    expect(screen.getByText(/上次生成不会自动重试/)).toBeVisible()
    expect(within(screen.getByRole('log', { name: '当前主题问答' })).getAllByText('中断时的问题')).toHaveLength(1)
    expect(client.ask).toHaveBeenCalledTimes(1)
    await act(async () => finish(answer))
  })

  it('revalidates each selected source and blocks generation if the previous scope cannot be restored', async () => {
    writeWorkspaceRecovery(scope, { ...cached(), projectFilter: '旧项目范围' })
    const client = mockClient()
    vi.mocked(client.getSource).mockRejectedValue(Object.assign(new Error('资料权限已撤销'), { status: 403 }))
    render(app(client))
    await screen.findByText(/上次的资料范围未能完整确认/)
    expect(client.get).toHaveBeenCalledWith('r1')
    expect(client.getSource).toHaveBeenCalledWith('paper-1', 'r1')
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    expect(client.ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '清除原范围，使用全部授权资料' }))
    expect(screen.getByRole('button', { name: '发送问题' })).toBeEnabled()
    expect(readWorkspaceRecovery(scope)?.selectedSourceIds).toEqual([])
    expect(readWorkspaceRecovery(scope)?.projectFilter).toBe('')
  })

  it('keeps source restoration bounded and only uses freshly verified source ids', async () => {
    writeWorkspaceRecovery(scope, cached())
    const client = mockClient()
    let resolve!: (value: KnowledgeSource) => void
    vi.mocked(client.getSource).mockImplementation(() => new Promise(done => { resolve = done }))
    render(app(client))
    await screen.findByRole('textbox', { name: '向AI提问' })
    expect(screen.getByRole('combobox', { name: '回答方式' })).toHaveValue('auto')
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled()
    await waitFor(() => expect(resolve).toBeDefined())
    await act(async () => resolve(paper))
    expect(screen.getByRole('button', { name: '发送问题' })).toBeEnabled()
    expect(client.ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(client.ask).toHaveBeenCalledWith('r1', expect.objectContaining({ sourceIds: ['paper-1'] }), expect.any(AbortSignal)))
  })

  it('preserves a legacy cached project scope without restoring the removed report-material controls', async () => {
    writeWorkspaceRecovery(scope, { ...cached(), projectFilter: '旧项目范围' })
    const client = mockClient()
    render(app(client))
    await screen.findByRole('textbox', { name: '向AI提问' })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送问题' })).toBeEnabled())
    expect(screen.getByText('知识库范围：指定 1 份资料 · 限于旧项目范围')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: '搜索知识资料' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '知识项目范围' })).not.toBeInTheDocument()
    expect(client.sources).not.toHaveBeenCalled()
    expect(client.ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(client.ask).toHaveBeenCalledWith('r1', expect.objectContaining({ sourceIds: ['paper-1'], projectName: '旧项目范围' }), expect.any(AbortSignal)))
    fireEvent.click(screen.getByRole('button', { name: '清除原范围，使用全部授权资料' }))
    expect(readWorkspaceRecovery(scope)?.projectFilter).toBe('')
    expect(readWorkspaceRecovery(scope)?.selectedSourceIds).toEqual([])
  })

  it('does not restore another identity, expired workspaces, or reports without fresh editing rights', async () => {
    writeWorkspaceRecovery(scope, cached())
    const client = mockClient()
    let view = render(app(client, 'different-issuer-subject'))
    await screen.findByRole('button', { name: '研究现场恢复验证' })
    expect(client.get).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    view.unmount()
    writeWorkspaceRecovery(scope, cached(), Date.now() - RECOVERY_TTL_MS)
    view = render(app(client))
    await screen.findByRole('button', { name: '研究现场恢复验证' })
    expect(client.get).not.toHaveBeenCalled()
    view.unmount()
    writeWorkspaceRecovery(scope, cached())
    vi.mocked(client.get).mockResolvedValue({ ...seed(), canEdit: false })
    render(app(client))
    await screen.findByRole('textbox', { name: '向AI提问' })
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('')
    expect(readWorkspaceRecovery(scope)).toBeNull()
    expect(client.ask).not.toHaveBeenCalled()
  })
})
