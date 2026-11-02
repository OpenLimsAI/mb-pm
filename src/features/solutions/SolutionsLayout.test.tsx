import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import type { KnowledgeSource, Solution, SolutionClient } from './types'

const seed = (): Solution => ({
  id: 'layout-report', title: '布局验证报告', projectName: '项目 A', productName: '研究制剂', ownerId: 'author', ownerName: '研究员',
  status: 'draft', revision: 1, version: 1, updatedAt: '2026-10-24T10:00:00Z', canEdit: true,
  sections: [{ id: 's1', title: '研究目标', content: '原始内容' }, { id: 's2', title: '验证安排', content: '第二章内容' }],
  formula: [{ id: 'f1', material: '候选物料', purpose: '', specification: '已有规格', amount: '', unit: '', basis: '', range: '', rationale: '', evidenceIds: [], verification: 'pending' }],
  references: [], reviewerId: null, reviewerName: '', reviewNotes: '',
})
const source: KnowledgeSource = {
  id: 'paper-1', title: '研究资料甲', kind: 'paper', authors: '作者甲', date: '2026-10-24', projectName: '项目 A', tags: [],
  content: '研究条件与观察', locator: '方法章节', version: '1', url: '', updatedAt: '2026-10-24T10:00:00Z',
}
function mockClient(): SolutionClient {
  let stored = seed()
  return {
    trash: vi.fn(async () => []), remove: vi.fn(async () => {}), restore: vi.fn(async () => seed()),
    list: vi.fn(async () => [structuredClone(stored)]), get: vi.fn(async () => structuredClone(stored)),
    create: vi.fn(async input => ({ ...seed(), ...input, id: 'created' })),
    save: vi.fn(async (_id, input) => { stored = { ...stored, ...input, revision: input.revision + 1 }; return structuredClone(stored) }),
    review: vi.fn(async () => structuredClone(stored)), versions: vi.fn(async () => []), reviewers: vi.fn(async () => []),
    sources: vi.fn(async () => [{ ...source, content: '' }]), getSource: vi.fn(async () => source),
    knowledgeStatus: vi.fn(async () => ({ configured: false, available: false, message: '尚未连接企业知识库' })),
    addSource: vi.fn(async input => ({ ...source, ...input })), history: vi.fn(async () => []),
    ask: vi.fn(async (_id, input) => ({ id: 'a1', question: input.question, content: '已检索的资料', references: [], context: input.context, scope: '', mode: 'retrieval' as const, createdAt: '2026-10-24T10:00:00Z' })),
    exportWord: vi.fn(async () => {}), publish: vi.fn(async () => source),
  }
}
async function mount(client = mockClient()) {
  const result = render(<SolutionsApp client={client} userId="author" userName="研究员" preview />)
  await screen.findByRole('textbox', { name: '章节正文' })
  const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
  act(() => window.dispatchEvent(new MessageEvent('message', {source:frame.contentWindow, origin:new URL(frame.src).origin, data:{type:'mberp:knowledge-library:ready',version:1,preview:true}})))
  return { ...result, client }
}
const moduleNames = { editor: '撰写报告', knowledge: '知识库资料', ai: 'AI 研究助手' }
type Module = keyof typeof moduleNames
function applyLayout(name: string, order: Module[]) {
  fireEvent.click(screen.getByRole('button', { name: '排列布局' }))
  const dialog = within(screen.getByRole('dialog', { name: '排列布局' }))
  fireEvent.click(dialog.getByRole('button', { name }))
  fireEvent.click(dialog.getByRole('button', { name: '重置顺序' }))
  for (const module of order) fireEvent.click(dialog.getByRole('button', { name: moduleNames[module] }))
  fireEvent.click(dialog.getByRole('button', { name: '应用排列' }))
}
function expectPlacement(arrangement: string, order: Module[]) {
  const grid = screen.getByRole('region', { name: '报告工作区' })
  expect(grid).toHaveAttribute('data-arrangement', arrangement)
  order.forEach((module, index) => {
    const element = grid.querySelector(`[data-module="${module}"]`)
    expect(element).toHaveAttribute('data-slot', String(index + 1))
    expect(element).toHaveStyle({ gridArea: `s${index + 1}`, order: String(index) })
  })
  expect([...grid.querySelectorAll('[data-module]')].map(element => element.getAttribute('data-module'))).toEqual(['editor', 'knowledge', 'ai'])
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown'); localStorage.setItem('ks-writing-mode', 'split'); sessionStorage.clear() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('independent workspace module layout', () => {
  it('keeps writing, question, source scope and library state while moving the same modules through all four grids', async () => {
    const { client } = await mount()
    const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
    act(() => window.dispatchEvent(new MessageEvent('message', {source:frame.contentWindow, origin:new URL(frame.src).origin, data:{type:'mberp:knowledge-library:selection',version:1,path:'sources/paper.md',title:source.title}})))
    fireEvent.click(screen.getByRole('button', {name:'加入问答范围'}))
    await waitFor(() => expect(client.getSource).toHaveBeenCalledWith('kb:sources/paper.md', 'layout-report'))
    await screen.findByText('已将《研究资料甲》加入问答范围。')
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: '打开章节：验证安排' }))
    const body = screen.getByRole('textbox', { name: '章节正文' })
    fireEvent.change(body, { target: { value: '切换布局时尚未提交的正文' } })
    fireEvent.click(screen.getByRole('button', { name: '就本章节提问' }))
    const context = screen.getByRole('textbox', { name: '附带上下文' })
    const question = screen.getByRole('textbox', { name: '向AI提问' })
    fireEvent.change(question, { target: { value: '仍在组织的问题' } })

    const cases: [string, string, Module[]][] = [
      ['横向三个', 'columns', ['ai', 'editor', 'knowledge']],
      ['左一右上下', 'left-main', ['knowledge', 'ai', 'editor']],
      ['左上下右一', 'right-main', ['editor', 'knowledge', 'ai']],
      ['上二下一', 'top-pair', ['knowledge', 'editor', 'ai']],
    ]
    for (const [name, arrangement, order] of cases) {
      applyLayout(name, order)
      expectPlacement(arrangement, order)
      expect(screen.getByRole('textbox', { name: '章节正文' })).toBe(body)
      expect(body).toHaveValue('切换布局时尚未提交的正文')
      expect(screen.getByRole('button', { name: '打开章节：验证安排' })).toHaveAttribute('aria-current', 'page')
      expect(screen.getByRole('textbox', { name: '向AI提问' })).toBe(question)
      expect(question).toHaveValue('仍在组织的问题')
      expect(screen.getByRole('textbox', { name: '附带上下文' })).toBe(context)
      expect(context).toHaveValue('切换布局时尚未提交的正文')
      expect(screen.getByTitle('原知识库资料')).toBe(frame)
      expect(screen.getByRole('button', {name:'加入问答范围'})).toBeEnabled()
      expect(screen.getByText(/已选 1 份资料/)).toBeInTheDocument()
    }
    expect(client.get).toHaveBeenCalledTimes(1)
    expect(client.history).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sessionStorage.getItem('ks-draft:preview:author:layout-report') || '{}').sections[1].content).toBe('切换布局时尚未提交的正文')
  }, 20000)

  it('does not save or mark a report dirty when only arrangement, visibility and outline width change', async () => {
    const { client } = await mount()
    vi.useFakeTimers()
    applyLayout('横向三个', ['ai', 'knowledge', 'editor'])
    fireEvent.click(screen.getByRole('button', { name: '隐藏知识库资料' }))
    fireEvent.click(screen.getByRole('button', { name: '展开知识库资料' }))
    fireEvent.click(screen.getByRole('button', { name: '隐藏章节目录' }))
    fireEvent.click(screen.getByRole('button', { name: '展开章节目录' }))
    fireEvent.keyDown(screen.getByRole('separator', { name: '调整章节目录宽度' }), { key: 'ArrowRight' })
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(client.save).not.toHaveBeenCalled()
    expect(client.get).toHaveBeenCalledTimes(1)
    expect(client.history).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('ks-draft:preview:author:layout-report')).toBeNull()
    expect(screen.getByRole('button', { name: '已保存到本机' })).toBeInTheDocument()
  })

  it('can hide all three modules, rearrange them and restore their existing input nodes independently', async () => {
    await mount()
    const question = screen.getByRole('textbox', { name: '向AI提问' })
    fireEvent.change(question, { target: { value: '隐藏时仍然保留的问题' } })
    fireEvent.click(screen.getByRole('button', { name: '收起撰写报告' }))
    fireEvent.click(screen.getByRole('button', { name: '隐藏知识库资料' }))
    fireEvent.click(screen.getByRole('button', { name: '隐藏AI 研究助手' }))
    expect(screen.queryByRole('textbox', { name: '章节正文' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    expect(question).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开AI 研究助手' }))
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toBe(question)
    expect(screen.queryByRole('textbox', { name: '章节正文' })).not.toBeInTheDocument()
    expect(screen.getByTitle('原知识库资料')).not.toBeVisible()
    for (const name of ['展开撰写报告', '展开知识库资料']) fireEvent.click(screen.getByRole('button', { name }))
    for (const name of ['收起撰写报告', '隐藏知识库资料', '隐藏AI 研究助手']) fireEvent.click(screen.getByRole('button', { name }))
    applyLayout('上二下一', ['ai', 'knowledge', 'editor'])
    expectPlacement('top-pair', ['ai', 'knowledge', 'editor'])
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBeInTheDocument()
    expect(screen.getByTitle('原知识库资料')).toBeVisible()
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toBe(question)
    expect(question).toHaveValue('隐藏时仍然保留的问题')
  })

  it('keeps the latest writing and revision when a previous autosave completes after a layout change', async () => {
    const { client } = await mount()
    let resolveSave!: (value: Solution) => void
    vi.mocked(client.save).mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve }))
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '已发送的正文' } })
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(client.save).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '保存中继续撰写的正文' } })
    applyLayout('左上下右一', ['knowledge', 'ai', 'editor'])
    await act(async () => resolveSave({ ...seed(), revision: 2, sections: [{ ...seed().sections[0], content: '已发送的正文' }, seed().sections[1]] }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('保存中继续撰写的正文')
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(client.save).toHaveBeenCalledTimes(2)
    expect(client.save).toHaveBeenLastCalledWith('layout-report', expect.objectContaining({ revision: 2, sections: [expect.objectContaining({ id: 's1', content: '保存中继续撰写的正文' }), seed().sections[1]] }))
  })

  it('applies settings only on confirmation and restores applied layout and outline preferences after remounting', async () => {
    const { client, unmount } = await mount()
    applyLayout('左上下右一', ['ai', 'editor', 'knowledge'])
    const applied = localStorage.getItem('ks-workspace-layout')
    fireEvent.click(screen.getByRole('button', { name: '排列布局' }))
    const dialog = within(screen.getByRole('dialog', { name: '排列布局' }))
    fireEvent.click(dialog.getByRole('button', { name: '横向三个' }))
    fireEvent.click(dialog.getByRole('button', { name: '重置顺序' }))
    expect(dialog.getByRole('button', { name: '应用排列' })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: '取消' }))
    expect(localStorage.getItem('ks-workspace-layout')).toBe(applied)
    expectPlacement('right-main', ['ai', 'editor', 'knowledge'])

    const separator = screen.getByRole('separator', { name: '调整章节目录宽度' })
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '360')
    fireEvent.click(screen.getByRole('button', { name: '隐藏章节目录' }))
    fireEvent.click(screen.getByRole('button', { name: '隐藏知识库资料' }))
    unmount()
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview />)
    await screen.findByRole('textbox', { name: '章节正文' })
    expectPlacement('right-main', ['ai', 'editor', 'knowledge'])
    expect(screen.getByTitle('原知识库资料')).not.toBeVisible()
    expect(screen.getByRole('button', { name: '展开知识库资料' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '章节目录' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开章节目录' }))
    expect(screen.getByRole('separator', { name: '调整章节目录宽度' })).toHaveAttribute('aria-valuenow', '360')
    expect(client.save).not.toHaveBeenCalled()
  })

  it('migrates the old combined-pane hidden preference without changing the default three-module layout', async () => {
    localStorage.setItem('ks-layout', JSON.stringify({ ratio: 70, left: true, right: false, knowledge: true, ai: true }))
    const client = mockClient()
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview />)
    await screen.findByRole('textbox', { name: '章节正文' })
    expectPlacement('left-main', ['editor', 'knowledge', 'ai'])
    expect(screen.getByTitle('原知识库资料')).not.toBeVisible()
    expect(screen.queryByRole('textbox', { name: '向AI提问' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开AI 研究助手' }))
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toBeInTheDocument()
    expect(screen.getByTitle('原知识库资料')).not.toBeVisible()
    expect(client.save).not.toHaveBeenCalled()
  })
})
