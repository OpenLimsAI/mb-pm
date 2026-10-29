import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
async function mount() {
  const client = createDemoClient('topics-test', 'author', '研究员')
  const originalAsk = client.ask
  const ask = vi.spyOn(client, 'ask')
  const view = render(<SolutionsApp client={client} userId="author" userName="研究员" preview />)
  await screen.findByRole('textbox', { name: '章节正文' })
  return { ...view, client, ask, originalAsk }
}
const topicSelect = () => screen.getByRole('combobox', { name: '对话主题' }) as HTMLSelectElement
const log = () => screen.getByRole('log', { name: '当前主题问答' })
async function send(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
  await within(log()).findByText(question, { exact: true })
}

describe('separate report research conversations', () => {
  it('continues one topic, starts another, and restores persisted threads after reopening', async () => {
    const { client, ask, unmount } = await mount()
    await send('缓冲体系有哪些文献依据？')
    const firstTopic = topicSelect().value
    await send('这些缓冲体系的实践有什么差异？')
    expect(ask.mock.calls.map(call => call[1].conversationId)).toEqual([firstTopic, firstTopic])
    expect(within(log()).getAllByRole('button', { name: '插入报告' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    expect(within(log()).queryByText('缓冲体系有哪些文献依据？')).not.toBeInTheDocument()
    await send('如何记录专家判断？')
    const secondTopic = topicSelect().value
    expect(secondTopic).not.toBe(firstTopic)
    expect(within(log()).getAllByRole('button', { name: '插入报告' })).toHaveLength(1)
    fireEvent.change(topicSelect(), { target: { value: firstTopic } })
    expect(within(log()).getByText('缓冲体系有哪些文献依据？')).toBeVisible()
    expect(within(log()).queryByText('如何记录专家判断？')).not.toBeInTheDocument()
    const saved = await client.history('demo-solution')
    expect(saved.map(answer => answer.conversationId)).toEqual([firstTopic, firstTopic, secondTopic])
    unmount()
    render(<SolutionsApp client={createDemoClient('topics-test', 'author', '研究员')} userId="author" userName="研究员" preview />)
    await waitFor(() => expect(topicSelect().options).toHaveLength(2))
    expect(within(log()).getByText('如何记录专家判断？')).toBeVisible()
    fireEvent.change(topicSelect(), { target: { value: firstTopic } })
    expect(within(log()).getAllByRole('button', { name: '插入报告' })).toHaveLength(2)
  })

  it('preserves a draft question and context while switching topics', async () => {
    await mount()
    await send('缓冲体系的文献依据')
    const savedTopic = topicSelect().value
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    const draftTopic = topicSelect().value
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '暂未发送的专家判断问题' } })
    fireEvent.change(topicSelect(), { target: { value: savedTopic } })
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('')
    fireEvent.change(topicSelect(), { target: { value: draftTopic } })
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('暂未发送的专家判断问题')
    expect(within(log()).queryByText('缓冲体系的文献依据')).not.toBeInTheDocument()
  })

  it('keeps an in-flight answer in its original topic without clearing another topic draft', async () => {
    const { client, ask, originalAsk } = await mount()
    let finish!: () => void
    ask.mockImplementation(async (id, input) => {
      const answer = await originalAsk.call(client, id, input)
      return new Promise(resolve => { finish = () => resolve(answer) })
    })
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '缓冲体系实践' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(finish).toBeDefined())
    const firstTopic = topicSelect().value
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '另一个主题的草稿' } })
    await act(async () => finish())
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('另一个主题的草稿')
    expect(within(log()).queryByText('缓冲体系实践')).not.toBeInTheDocument()
    fireEvent.change(topicSelect(), { target: { value: firstTopic } })
    expect(within(log()).getByText('缓冲体系实践')).toBeVisible()
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('')
  })

  it('confirms each answer before inserting it, retains source records, and can undo', async () => {
    await mount()
    const body = screen.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
    const original = body.value
    await send('缓冲体系有哪些相关资料？')
    fireEvent.click(within(log()).getByRole('button', { name: '插入报告' }))
    const dialog = screen.getByRole('dialog', { name: '确认采纳 · 知识摘录' })
    expect(body).toHaveValue(original)
    const content = (within(dialog).getByRole('textbox', { name: '确认或改写内容' }) as HTMLTextAreaElement).value
    fireEvent.click(within(dialog).getByRole('button', { name: '确认插入并保留引用' }))
    expect(body.value).toContain(content)
    expect(screen.getByRole('button', { name: /本章节参考依据/ })).toHaveTextContent(/[1-4]/)
    fireEvent.click(screen.getByRole('button', { name: '撤销插入' }))
    expect(body).toHaveValue(original)
  })
})
