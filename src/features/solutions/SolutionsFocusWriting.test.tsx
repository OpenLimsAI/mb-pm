import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import type { Answer, KnowledgeSource, Solution, SolutionClient } from './types'

const seed = (): Solution => ({
  id: 'focus-report', title: '专注撰写验证报告', projectName: '项目 A', productName: '研究制剂',
  ownerId: 'author', ownerName: '研究员', status: 'draft', revision: 1, version: 1,
  updatedAt: '2026-10-24T10:00:00Z', canEdit: true,
  sections: [
    { id: 's1', title: '研究目标', content: '前文。\n\n后文。' },
    { id: 's2', title: '验证安排', content: '第二章内容' },
  ],
  formula: [{ id: 'f1', material: '候选物料', purpose: '', specification: '已有规格', amount: '', unit: '', basis: '', range: '', rationale: '', evidenceIds: [], verification: 'pending' }],
  references: [], reviewerId: null, reviewerName: '', reviewNotes: '',
})
const source: KnowledgeSource = {
  id: 'paper-1', title: '相关研究资料', kind: 'paper', authors: '', date: '', projectName: '项目 A',
  tags: [], content: '资料证据原文', locator: '方法章节', version: '1', url: '', updatedAt: '2026-10-24T10:00:00Z',
}
const existingAnswer: Answer = {
  id: 'answer-existing', question: '已有研究结论是什么？', content: '已保存的问答内容。', references: [],
  context: '', scope: '全部授权资料', mode: 'retrieval', createdAt: '2026-10-24T10:00:00Z',
}
function mockClient(): SolutionClient {
  let stored = seed()
  return {
    trash: vi.fn(async () => []), remove: vi.fn(async () => {}), restore: vi.fn(async () => seed()),
    list: vi.fn(async () => [structuredClone(stored)]), get: vi.fn(async () => structuredClone(stored)),
    create: vi.fn(async input => ({ ...seed(), ...input, id: 'created' })),
    save: vi.fn(async (_id, input) => { stored = { ...stored, ...structuredClone(input), revision: input.revision + 1 }; return structuredClone(stored) }),
    review: vi.fn(async () => structuredClone(stored)), versions: vi.fn(async () => []), reviewers: vi.fn(async () => []),
    sources: vi.fn(async () => [source]), getSource: vi.fn(async () => source),
    knowledgeStatus: vi.fn(async () => ({ configured: false, available: false, message: '本地测试资料' })),
    addSource: vi.fn(async input => ({ ...source, ...input })), history: vi.fn(async () => [existingAnswer]),
    ask: vi.fn(async (_id, input) => ({ ...existingAnswer, id: 'answer-inline', question: input.question, content: '行内问题的资料回答。', context: input.context })),
    exportWord: vi.fn(async () => {}), publish: vi.fn(async () => source),
  }
}
async function mount(client = mockClient(), preview = true) {
  const result = render(<SolutionsApp client={client} userId="author" userName="研究员" preview={preview} />)
  await screen.findByRole('textbox', { name: '章节正文' })
  return { ...result, client }
}
function tool(name: string) {
  return within(screen.getByRole('navigation', { name: '写作工具' })).getByRole('button', { name })
}
function writingSwitch(checked: boolean) { return within(screen.getByRole('region', { name: '撰写报告' })).getByRole('switch', { name: '专注模式', checked }) }
function split() { fireEvent.click(writingSwitch(true)) }
function focus() { fireEvent.click(writingSwitch(false)) }
function insertInlineCard() {
  const input = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
  const offset = '前文。\n\n'.length
  const value = input.value.slice(0, offset) + '/' + input.value.slice(offset)
  fireEvent.input(input, { target: { value, selectionStart: offset + 1, selectionEnd: offset + 1 }, inputType: 'insertText', data: '/' })
  fireEvent.click(screen.getByRole('menuitem', { name: /AI 问答/ }))
  return screen.getByRole('region', { name: '正文 AI 问答' })
}

beforeEach(() => { localStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown'); sessionStorage.clear(); localStorage.setItem('ks-writing-mode', 'focus') })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('focus writing workspace', () => {
  it('returns to the report home through the highlighted header control after saving current edits', async () => {
    const { client } = await mount()
    const body = screen.getByRole('textbox', { name: '章节正文' })
    fireEvent.change(body, { target: { value: '返回主页前的修改' } })
    const home = screen.getByRole('button', { name: '研究报告主页' })
    expect(home).toHaveClass('app-workbench-link')
    fireEvent.click(home)
    await screen.findByRole('heading', { name: /我的报告/ })
    expect(client.save).toHaveBeenCalledWith('focus-report', expect.objectContaining({ sections: expect.arrayContaining([expect.objectContaining({ content: '返回主页前的修改' })]) }))
    expect(screen.queryByRole('textbox', { name: '章节正文' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '专注撰写验证报告' }))
    expect(await screen.findByRole('textbox', { name: '章节正文' })).toHaveValue('返回主页前的修改')
  })
  it('keeps writing visible if saving before returning home fails', async () => {
    const client = mockClient()
    vi.mocked(client.save).mockRejectedValue(new Error('保存暂时失败'))
    await mount(client)
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '不能丢失的修改' } })
    fireEvent.click(screen.getByRole('button', { name: '研究报告主页' }))
    await screen.findByText('当前修改尚未保存，请先处理保存失败后再返回主页。')
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('不能丢失的修改')
    expect(screen.queryByRole('heading', { name: /我的报告/ })).not.toBeInTheDocument()
  })
  it.each([true, false])('keeps platform navigation in the global header and the single visible focus switch in the editor (preview=%s)', async preview => {
    const { container, client } = await mount(mockClient(), preview)
    const header = container.querySelector<HTMLElement>('.ks-topbar')!
    const editor = screen.getByRole('region', { name: '撰写报告' })
    const body = within(editor).getByRole('textbox', { name: '章节正文' })
    const frame = screen.getByTitle('原知识库资料')
    const edited = '保留我的修改。\n\n前文。\n\n后文。'
    fireEvent.change(body, { target: { value: edited } })

    for (const focused of [true, false, true]) {
      expect(within(header).queryByRole('switch', { name: '专注模式', hidden: true })).not.toBeInTheDocument()
      const platformLink = within(header).getByRole('link', { name: '应用工作台' })
      expect(platformLink).toBeVisible()
      expect(platformLink).toHaveTextContent('工作台')
      expect(platformLink).toHaveAttribute('href', preview ? '/?preview=1' : '/')
      expect(platformLink).toHaveClass('app-workbench-link')
      expect(within(header).queryByRole('button', { name: '提交评审' })).not.toBeInTheDocument()
      expect(screen.getAllByRole('switch', { name: '专注模式' })).toHaveLength(1)
      expect(within(editor).getAllByRole('switch', { name: '专注模式' })).toHaveLength(1)
      const toggle = writingSwitch(focused)
      expect(toggle).toBeVisible()
      expect(toggle).toBeEnabled()
      expect(toggle.closest(focused ? '.ks-focus-toolbar' : '.ks-pane-heading')).not.toBeNull()
      expect(screen.getByRole('region', { name: '撰写报告' })).toBe(editor)
      expect(screen.getByRole('textbox', { name: '章节正文' })).toBe(body)
      expect(body).toHaveValue(edited)
      expect(screen.getByTitle('原知识库资料')).toBe(frame)
      fireEvent.click(toggle)
    }
    expect(client.save).not.toHaveBeenCalled()
    expect(body).toHaveValue(edited)
  })

  it('starts in split mode until the explicit focus switch is turned on', async () => {
    localStorage.removeItem('ks-writing-mode')
    const { container } = await mount()
    expect(container.querySelector('.ks-app')).not.toHaveClass('ks-focus-writing')
    expect(screen.getByRole('switch', { name: '专注模式' })).not.toBeChecked()
    focus()
    expect(container.querySelector('.ks-app')).toHaveClass('ks-focus-writing')
    expect(screen.getByRole('switch', { name: '专注模式' })).toBeChecked()
    expect(screen.queryByRole('button', { name: '切换到分栏布局' })).not.toBeInTheDocument()
    split()
    expect(container.querySelector('.ks-app')).not.toHaveClass('ks-focus-writing')
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('前文。\n\n后文。')
  })

  it('restores the saved focus mode and never saves merely for switching modes or tools', async () => {
    const { container, client } = await mount()
    expect(container.querySelector('.ks-app')).toHaveClass('ks-focus-writing')
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBeVisible()
    expect(screen.queryByRole('region', { name: '知识库资料面板' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'AI研究助手面板' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '章节目录' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '展开候选物料依据' })).not.toBeInTheDocument()
    expect(screen.getByTitle('原知识库资料')).toBeInTheDocument()
    vi.useFakeTimers()
    fireEvent.click(tool('打开AI研究助手'))
    fireEvent.click(tool('收起AI研究助手'))
    split()
    expect(localStorage.getItem('ks-writing-mode')).toBe('split')
    focus()
    expect(localStorage.getItem('ks-writing-mode')).toBe('focus')
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(client.save).not.toHaveBeenCalled()
    expect(client.get).toHaveBeenCalledTimes(1)
    expect(client.history).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('ks-draft:preview:author:focus-report')).toBeNull()
    expect(screen.getByRole('button', { name: '已保存到本机' })).toBeInTheDocument()
  })

  it('opens only one writing tool at a time and closes the outline after choosing a chapter', async () => {
    const { container } = await mount()
    const app = container.querySelector('.ks-app')!
    const cases = [
      ['打开知识库资料', 'knowledge'], ['打开AI研究助手', 'ai'],
      ['打开参考依据', 'references'], ['打开报告信息', 'info'], ['打开章节目录', 'outline'],
    ]
    for (const [label, active] of cases) {
      fireEvent.click(tool(label))
      expect(app).toHaveAttribute('data-focus-tool', active)
      expect(within(screen.getByRole('navigation', { name: '写作工具' })).getAllByRole('button', { pressed: true })).toHaveLength(1)
      expect(screen.queryByRole('region', { name: '知识库资料面板' }) !== null).toBe(active === 'knowledge')
      expect(screen.queryByRole('region', { name: 'AI研究助手面板' }) !== null).toBe(active === 'ai')
      expect(screen.queryByRole('navigation', { name: '章节目录' }) !== null).toBe(active === 'outline')
      expect(screen.queryByRole('button', { name: '打开配方表' })).not.toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: '章节正文' })).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: '打开章节：验证安排' }))
    expect(app).toHaveAttribute('data-focus-tool', 'none')
    expect(screen.queryByRole('navigation', { name: '章节目录' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('第二章内容')
    expect(screen.getByRole('combobox', { name: '当前章节' })).toHaveValue('s2')
  })

  it('retains the same original knowledge iframe, readiness and selected paper across modes', async () => {
    await mount()
    const frame = screen.getByTitle('原知识库资料') as HTMLIFrameElement
    const frameWindow = frame.contentWindow
    const origin = new URL(frame.src).origin
    fireEvent.click(tool('打开知识库资料'))
    fireEvent(window, new MessageEvent('message', { source: frameWindow, origin, data: { type: 'mberp:knowledge-library:ready', version: 1, preview: true } }))
    fireEvent(window, new MessageEvent('message', { source: frameWindow, origin, data: { type: 'mberp:knowledge-library:selection', version: 1, path: 'sources/quality.md', title: '知识库当前论文' } }))
    expect(frame).toHaveClass('is-ready')
    expect(screen.getByRole('button', { name: '加入问答范围' })).toBeEnabled()
    split()
    expect(screen.getByTitle('原知识库资料')).toBe(frame)
    expect(frame.contentWindow).toBe(frameWindow)
    expect(screen.getByText('知识库当前论文')).toBeVisible()
    focus()
    expect(frame).not.toBeVisible()
    fireEvent.click(tool('打开知识库资料'))
    expect(screen.getByTitle('原知识库资料')).toBe(frame)
    expect(frame.contentWindow).toBe(frameWindow)
    expect(frame).toHaveClass('is-ready')
    expect(screen.getByText('知识库当前论文')).toBeVisible()
    expect(screen.getByRole('button', { name: '引用到章节' })).toBeEnabled()
  })

  it('preserves question drafts, answer history, inline cards across modes', async () => {
    await mount()
    fireEvent.click(tool('打开AI研究助手'))
    const question = screen.getByRole('textbox', { name: '向AI提问' })
    fireEvent.change(question, { target: { value: '尚未发送的问题' } })
    expect(screen.getByText(existingAnswer.content)).toBeVisible()

    const card = insertInlineCard()
    const inlineQuestion = within(card).getByRole('textbox', { name: '想了解什么？' })
    fireEvent.change(inlineQuestion, { target: { value: '需要哪些验证证据？' } })
    fireEvent.click(within(card).getByRole('button', { name: '提问' }))
    expect(await within(card).findByText('行内问题的资料回答。')).toBeVisible()
    const body = screen.getByRole('textbox', { name: '章节正文' })
    split()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBe(body)
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toBe(question)
    expect(question).toHaveValue('尚未发送的问题')
    expect(screen.getByText(existingAnswer.content)).toBeVisible()
    expect(screen.getByRole('region', { name: '正文 AI 问答' })).toBe(card)
    expect(within(card).getByRole('textbox', { name: '想了解什么？' })).toBe(inlineQuestion)
    expect(inlineQuestion).toHaveValue('需要哪些验证证据？')
    focus()
    expect(screen.getByRole('region', { name: '正文 AI 问答' })).toBe(card)
    expect(within(card).getByText('行内问题的资料回答。')).toBeVisible()
    fireEvent.click(tool('打开AI研究助手'))
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toBe(question)
    expect(question).toHaveValue('尚未发送的问题')
    expect(screen.getByText(existingAnswer.content)).toBeVisible()
  })

  it('restores the exact split layout and panel preferences after temporary focus tool changes', async () => {
    const layout = { arrangement: 'right-main', order: ['ai', 'editor', 'knowledge'] }
    const panels = { visible: { editor: true, knowledge: false, ai: true }, outlineVisible: false, outlineWidth: 312 }
    localStorage.setItem('ks-writing-mode', 'split')
    localStorage.setItem('ks-workspace-layout', JSON.stringify(layout))
    localStorage.setItem('ks-workspace-panels', JSON.stringify(panels))
    await mount()
    const grid = screen.getByRole('region', { name: '报告工作区' })
    const beforeStyle = grid.getAttribute('style')
    const beforeLayout = localStorage.getItem('ks-workspace-layout')
    const beforePanels = localStorage.getItem('ks-workspace-panels')
    const modules = [...grid.querySelectorAll<HTMLElement>('[data-module]')]
    const beforeModules = modules.map(node => ({ hidden: node.hidden, style: node.getAttribute('style'), slot: node.getAttribute('data-slot') }))
    focus()
    fireEvent.click(tool('打开知识库资料'))
    fireEvent.click(tool('打开章节目录'))
    fireEvent.click(tool('收起章节目录'))
    split()
    expect(screen.getByRole('region', { name: '报告工作区' })).toBe(grid)
    expect(grid).toHaveAttribute('data-arrangement', 'right-main')
    expect(grid.getAttribute('style')).toBe(beforeStyle)
    modules.forEach((node, index) => {
      expect(grid.querySelector(`[data-module="${node.dataset.module}"]`)).toBe(node)
      expect({ hidden: node.hidden, style: node.getAttribute('style'), slot: node.getAttribute('data-slot') }).toEqual(beforeModules[index])
    })
    expect(localStorage.getItem('ks-workspace-layout')).toBe(beforeLayout)
    expect(localStorage.getItem('ks-workspace-panels')).toBe(beforePanels)
    expect(screen.queryByRole('region', { name: '知识库资料面板' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '章节目录' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开章节目录' }))
    expect(screen.getByRole('separator', { name: '调整章节目录宽度' })).toHaveAttribute('aria-valuenow', '312')
  })

  it('lets a modal handle Escape before closing its underlying focus tool', async () => {
    await mount()
    fireEvent.click(tool('打开章节目录'))
    fireEvent.click(screen.getByRole('button', { name: '章节操作：研究目标' }))
    const dialog = screen.getByRole('dialog', { name: '章节操作' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '章节操作' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '章节目录' })).toBeVisible()
    expect(tool('收起章节目录')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('navigation', { name: '章节目录' })).not.toBeInTheDocument()
    expect(tool('打开章节目录')).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps inline questions anchored while formatting and undoing either text segment', async () => {
    await mount()
    const card = insertInlineCard()
    const first = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
    const second = screen.getByRole('textbox', { name: '章节正文（续 1）' }) as HTMLTextAreaElement
    fireEvent.focus(second)
    fireEvent.select(second, { target: { selectionStart: 0, selectionEnd: 2 } })
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))
    expect(first).toHaveValue('前文。\n\n')
    expect(second).toHaveValue('**后文**。')
    expect(screen.getByRole('region', { name: '正文 AI 问答' })).toBe(card)
    split()
    fireEvent.click(screen.getByRole('button', { name: '撤销正文编辑' }))
    expect(first).toHaveValue('前文。\n\n')
    expect(second).toHaveValue('后文。')
    fireEvent.focus(first)
    fireEvent.select(first, { target: { selectionStart: 0, selectionEnd: 2 } })
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))
    expect(first).toHaveValue('**前文**。\n\n')
    expect(second).toHaveValue('后文。')
    fireEvent.click(screen.getByRole('button', { name: '撤销正文编辑' }))
    expect(first).toHaveValue('前文。\n\n')
    expect(screen.getByRole('region', { name: '正文 AI 问答' })).toBe(card)
  })
})
