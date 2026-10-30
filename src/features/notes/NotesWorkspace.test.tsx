import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import NotesWorkspace from './NotesWorkspace'
import NoteEditor from './NoteEditor'
import { createPreviewNotesClient } from './client'
import { newNote } from './draft'

beforeEach(() => localStorage.clear())
it('creates, edits, searches and restores personal notes', async () => {
  const client = createPreviewNotesClient('person')
  render(<NotesWorkspace client={client} />)
  await screen.findByText('还没有笔记')
  fireEvent.click(screen.getByRole('button', { name: '新建笔记' }))
  const dialog = screen.getByRole('dialog', { name: '存入我的笔记' })
  fireEvent.change(within(dialog).getByLabelText('笔记标题'), { target: { value: '实验观察' } })
  fireEvent.change(within(dialog).getByLabelText('笔记正文'), { target: { value: '独立保存的个人思考。' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存笔记' }))
  await screen.findByRole('heading', { name: '实验观察' })
  fireEvent.click(screen.getByRole('button', { name: '编辑笔记' }))
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '补充后的个人思考。' } })
  fireEvent.click(screen.getByRole('button', { name: '保存笔记' }))
  await screen.findByText('补充后的个人思考。')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索我的笔记' }), { target: { value: '不存在的关键词' } })
  await screen.findByText('没有匹配的笔记')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索我的笔记' }), { target: { value: '' } })
  fireEvent.click(await screen.findByRole('button', { name: '移至回收站：实验观察' }))
  await screen.findByText('还没有笔记')
  fireEvent.click(screen.getByRole('button', { name: '撤销移除' }))
  await screen.findByRole('heading', { name: '实验观察' })
  expect((await client.list()).items[0].content).toBe('补充后的个人思考。')
})
it('keeps the draft on failure and prevents duplicate saves or closing while pending', async () => {
  const client = createPreviewNotesClient('person'), draft = newNote({ title: '保留的标题', content: '不能丢失的正文' }), onClose = vi.fn()
  let reject!: (error: Error) => void
  const save = vi.spyOn(client, 'create').mockImplementation(() => new Promise((_, no) => { reject = no }))
  render(<NoteEditor client={client} draft={draft} onClose={onClose} onSaved={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '保存笔记' }))
  fireEvent.click(screen.getByRole('button', { name: '保存中…' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('版本冲突，正文已保留。')))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('笔记正文')).toHaveValue('不能丢失的正文')
  await waitFor(() => expect(screen.getByRole('button', { name: '保存笔记' })).toBeEnabled())
})
it('uses the application sidebar to browse origins and keeps the current category usable', async () => {
  const client = createPreviewNotesClient('person')
  for (const [sourceApp, title] of [['manual', '个人观察'], ['solutions', '报告中的发现'], ['information', '行业摘录'], ['knowledge', '论文摘录']] as const) {
    const draft = newNote({ title, sourceApp, content: '记录与思考' }); await client.create(draft.id, draft)
  }
  const list = vi.spyOn(client, 'list')
  render(<NotesWorkspace client={client} mode="app" userName="研究员" />)
  await screen.findByRole('heading', { name: '个人观察' })
  const nav = screen.getByRole('navigation', { name: '笔记分类' })
  fireEvent.click(within(nav).getByRole('button', { name: '研究报告' }))
  await screen.findByRole('heading', { name: '报告中的发现' })
  expect(screen.queryByRole('heading', { name: '个人观察' })).not.toBeInTheDocument()
  expect(within(nav).getByRole('button', { name: '研究报告' })).toHaveAttribute('aria-current', 'page')
  const count = list.mock.calls.length
  fireEvent.click(within(nav).getByRole('button', { name: '研究报告' }))
  expect(screen.getByRole('heading', { name: '报告中的发现' })).toBeInTheDocument()
  expect(list).toHaveBeenCalledTimes(count)
  fireEvent.click(within(nav).getByRole('button', { name: '回收站' }))
  await screen.findByText('回收站为空')
  fireEvent.click(within(nav).getByRole('button', { name: '全部笔记' }))
  await screen.findByRole('heading', { name: '行业摘录' })
  fireEvent.click(within(nav).getByRole('button', { name: '知识库' }))
  await screen.findByRole('heading', { name: '论文摘录' })
  expect(screen.queryByRole('heading', { name: '行业摘录' })).not.toBeInTheDocument()
  expect(await client.list()).toMatchObject({ total: 4 })
})

it('requires confirmation before explicitly sharing a private note', async () => {
  const client = createPreviewNotesClient('share-test')
  const draft = newNote({ title: '私人记录', content: '只有本人可见' })
  await client.create(draft.id, draft)
  const share = vi.fn(async (note) => note)
  const api = { ...client, share }
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<NotesWorkspace client={api} />)
  await screen.findByRole('heading', { name: '私人记录' })
  fireEvent.click(screen.getByRole('button', { name: '共享到知识库检索' }))
  expect(share).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: '共享到知识库检索' }))
  await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ id: draft.id }), true))
  confirm.mockRestore()
})
