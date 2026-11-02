import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'
import { createPreviewNotesClient } from '../notes/client'

beforeEach(() => { localStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown'); sessionStorage.clear(); localStorage.setItem('ks-writing-mode', 'split') })
it('opens the report home first without reading a document or question history', async () => {
  const client = createDemoClient('home-test', 'author', '研究员'), get = vi.spyOn(client, 'get'), history = vi.spyOn(client, 'history')
  render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
  await screen.findByText('缓冲体系选择与验证报告')
  expect(screen.queryByRole('textbox', { name: '章节正文' })).not.toBeInTheDocument()
  expect(get).not.toHaveBeenCalled()
  expect(history).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '缓冲体系选择与验证报告' }))
  await screen.findByRole('textbox', { name: '章节正文' })
  expect(get).toHaveBeenCalledWith('demo-solution')
})
it('captures selected writing as a private note with origin, without changing the report or calling AI', async () => {
  const client = createDemoClient('note-test', 'author', '研究员'), ask = vi.spyOn(client, 'ask'), polish = vi.spyOn(client, 'polish'), notes = createPreviewNotesClient('owner')
  render(<SolutionsApp client={client} userId="author" userName="研究员" preview notesClient={notes} />)
  const body = await screen.findByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
  const original = body.value, excerpt = original.slice(5, 24)
  fireEvent.focus(body)
  fireEvent.select(body, { target: { selectionStart: 5, selectionEnd: 24 } })
  expect(screen.getByRole('button', { name: '询问 AI' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Polish 文字' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '存入我的笔记' }))
  const dialog = screen.getByRole('dialog', { name: '存入我的笔记' })
  expect(within(dialog).getByLabelText('笔记正文')).toHaveValue(excerpt)
  expect(dialog).toHaveTextContent('缓冲体系选择与验证报告 · 研究目标与适用范围')
  fireEvent.click(within(dialog).getByRole('button', { name: '保存笔记' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '存入我的笔记' })).not.toBeInTheDocument())
  const saved = (await createPreviewNotesClient('owner').list()).items[0]
  expect(saved).toMatchObject({ content: excerpt, sourceApp: 'solutions', sourceUrl: '/solutions?preview=1' })
  expect(body).toHaveValue(original)
  expect(ask).not.toHaveBeenCalled()
  expect(polish).not.toHaveBeenCalled()
})
