import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('ks-editor-mode', 'markdown')
  localStorage.setItem('ks-writing-mode', 'split')
})

async function mount() {
  const client = createDemoClient('assistant-layout', 'author', '研究员')
  const ask = vi.spyOn(client, 'ask')
  render(<SolutionsApp client={client} userId="author" userName="研究员" preview />)
  await screen.findByRole('textbox', { name: '章节正文' })
  return { ask }
}

describe('compact report assistant controls', () => {
  it('closes floating settings when hiding the assistant and preserves its draft', async () => {
    await mount()
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '尚未发送的问题' } })
    fireEvent.click(screen.getByRole('button', { name: '回答设置' }))
    expect(screen.getByRole('combobox', { name: '回答方式' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '隐藏AI 研究助手' }))
    expect(screen.queryByRole('combobox', { name: '回答方式' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开AI 研究助手' }))
    expect(screen.getByRole('button', { name: '回答设置' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('尚未发送的问题')
  })

  it('keeps answering settings available without hiding the conversation or changing a question draft', async () => {
    const { ask } = await mount()
    const toggle = screen.getByRole('button', { name: '回答设置' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('自动判断')
    expect(screen.queryByRole('combobox', { name: '回答方式' })).not.toBeInTheDocument()
    expect(screen.getByRole('log', { name: '当前主题问答' })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '保留这个研究问题' } })

    fireEvent.click(toggle)
    fireEvent.change(screen.getByRole('combobox', { name: '回答方式' }), { target: { value: 'general' } })
    fireEvent.click(screen.getByRole('button', { name: /搜索服务/ }))
    expect(screen.getByText('联网搜索界面演示')).toBeVisible()
    expect(ask).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(toggle).toHaveTextContent('通用回答 · 不联网')
    expect(screen.getByRole('textbox', { name: '向AI提问' })).toHaveValue('保留这个研究问题')
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(ask).toHaveBeenCalledWith('demo-solution', expect.objectContaining({ answerMode: 'general', question: '保留这个研究问题' }), expect.any(AbortSignal)))
  })

  it('expands context options from the compact summary and preserves the chosen context after closing it', async () => {
    const { ask } = await mount()
    expect(screen.queryByRole('combobox', { name: 'AI写作上下文' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '不附带正文' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'AI写作上下文' }), { target: { value: 'chapter' } })
    const context = screen.getByRole('textbox', { name: '附带上下文' }) as HTMLTextAreaElement
    const expected = context.value
    expect(expected).not.toBe('')
    expect(context).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: /附带上下文 ·/ }))
    expect(screen.queryByRole('combobox', { name: 'AI写作上下文' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '向AI提问' }), { target: { value: '根据刚才的章节分析' } })
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }))
    await waitFor(() => expect(ask).toHaveBeenCalledWith('demo-solution', expect.objectContaining({ context: expected }), expect.any(AbortSignal)))
  })
})
