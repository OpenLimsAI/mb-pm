import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown') })
async function mount() {
  const client = createDemoClient('continuous', 'author', '作者')
  render(<SolutionsApp client={client} userId="author" userName="作者" preview />)
  await screen.findByRole('textbox', { name: '章节正文' })
  return client
}
describe('continuous research report writing', () => {
  it('edits the intended chapter and preserves every other chapter', async () => {
    const client = await mount(), before = await client.get('demo-solution')
    fireEvent.click(screen.getByRole('button', { name: '切换连续编辑' }))
    const section = screen.getByRole('region', { name: '撰写章节：已有知识与实践基础' })
    const body = within(section).getByRole('textbox', { name: '章节正文' })
    fireEvent.focus(body); fireEvent.change(body, { target: { value: '第二章独立更新' } })
    fireEvent.click(screen.getByRole('button', { name: '有修改 · 将自动保存' }))
    await waitFor(async () => expect((await client.get('demo-solution')).sections[1].content).toBe('第二章独立更新'))
    const after = await client.get('demo-solution')
    expect(after.sections[0].content).toBe(before.sections[0].content)
    fireEvent.click(screen.getByRole('button', { name: '切换连续编辑' }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('第二章独立更新')
  })
  it('sends the displayed whole-report context with a bounded length', async () => {
    const client = await mount(), ask = vi.spyOn(client, 'ask')
    fireEvent.click(screen.getByRole('button', { name: '不附带正文' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'AI写作上下文' }), { target: { value: 'report' } })
    const context = screen.getByRole('textbox', { name: '附带上下文' }) as HTMLTextAreaElement
    expect(context.readOnly).toBe(true)
    expect(context.value).toContain('## 研究目标与适用范围')
    expect(context.value).toContain('## 已有知识与实践基础')
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '检查整篇报告中的研究问题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(ask).toHaveBeenCalled())
    expect(ask.mock.calls[0][1].context).toBe(context.value)
    expect(ask.mock.calls[0][1].context.length).toBeLessThanOrEqual(10000)
  })
  it('shares an explicitly selected template and lets its author revoke sharing', async () => {
    const client = await mount()
    fireEvent.click(screen.getByRole('button', { name: '保存章节模板' }))
    const dialog = screen.getByRole('dialog', { name: '章节模板' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '模板名称' }), { target: { value: '团队实验规范' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '共享给同组织团队成员' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存模板' }))
    await screen.findByText('团队模板已共享，同组织成员新建报告时可选择。')
    expect((await client.templates!())[0]).toMatchObject({ shared: true, sourceSolutionId: 'demo-solution' })
    fireEvent.click(screen.getByRole('button', { name: '保存章节模板' }))
    fireEvent.click(screen.getByRole('button', { name: '取消共享' }))
    await waitFor(async () => expect((await client.templates!())[0].shared).toBe(false))
  })

  it('announces normal writing position without opening the collaboration panel', async () => {
    const client = createDemoClient('presence-writing', 'author', '作者'), presence = vi.spyOn(client, 'presence')
    render(<SolutionsApp client={client} userId="author" userName="作者" preview />)
    await screen.findByRole('textbox', { name: '章节正文' })
    await waitFor(() => expect(presence).toHaveBeenCalledWith('demo-solution', 'section-1'))
    fireEvent.click(screen.getByRole('button', { name: '打开章节：已有知识与实践基础' }))
    await waitFor(() => expect(presence).toHaveBeenLastCalledWith('demo-solution', 'section-2'))
    fireEvent.click(screen.getByRole('button', { name: '研究报告主页' }))
    await screen.findByRole('button', { name: '缓冲体系选择与验证报告' })
    const count = presence.mock.calls.length
    vi.useFakeTimers()
    await act(() => vi.advanceTimersByTimeAsync(21000))
    expect(presence).toHaveBeenCalledTimes(count)
    vi.useRealTimers()
  })

  it('creates a scenario template with visible writing requirements', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '新建报告' }))
    const dialog = screen.getByRole('dialog', { name: '新建研究报告' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '报告名称' }), { target: { value: '实验复盘' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: '报告模板' }), { target: { value: 'experiment' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '开始撰写' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement).value).toContain('写作要求：'))
    expect(screen.getByRole('button', { name: '打开章节：实验目的与假设' })).toBeInTheDocument()
  })
})
