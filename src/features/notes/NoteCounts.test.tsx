import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import NotesWorkspace from './NotesWorkspace'
import { createPreviewNotesClient } from './client'
import type { NotesClient } from './client'
import { newNote } from './draft'

beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
function badge(name: string) {
  return within(screen.getByRole('navigation', { name: '笔记分类' })).getByRole('button', { name }).querySelector('.pn-nav-count')!
}
it('counts all pages and keeps source totals independent of selection and search', async () => {
  const client = createPreviewNotesClient('counts')
  for (const [sourceApp, count] of [['solutions', 51], ['knowledge', 2], ['information', 1], ['manual', 0]] as const) {
    for (let n = 0; n < count; n++) { const draft = newNote({ sourceApp, title: `${sourceApp}-${n}`, content: '正文' }); await client.create(draft.id, draft) }
  }
  const trashDraft = newNote({ title: '回收记录', content: '原内容' })
  await client.trash(await client.create(trashDraft.id, trashDraft))
  render(<NotesWorkspace client={client} mode="app" />)
  await waitFor(() => expect(badge('全部笔记')).toHaveTextContent(/^54$/))
  expect(badge('研究报告')).toHaveTextContent(/^51$/)
  expect(badge('知识库')).toHaveTextContent(/^2$/)
  expect(badge('行业信息')).toHaveTextContent(/^1$/)
  expect(badge('个人记录')).toHaveTextContent(/^0$/)
  expect(badge('回收站')).toHaveTextContent(/^1$/)
  fireEvent.click(screen.getByRole('button', { name: '研究报告' }))
  await screen.findByRole('button', { name: '加载更多笔记' })
  fireEvent.click(screen.getByRole('button', { name: '加载更多笔记' }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: /查看笔记：/ })).toHaveLength(51))
  fireEvent.change(screen.getByRole('textbox', { name: '搜索我的笔记' }), { target: { value: '不存在的关键词' } })
  await screen.findByText('没有匹配的笔记')
  expect(badge('全部笔记')).toHaveTextContent(/^54$/)
  expect(badge('研究报告')).toHaveTextContent(/^51$/)
})
it('refreshes the counts after creating, trashing and restoring a note', async () => {
  const client = createPreviewNotesClient('mutations')
  render(<NotesWorkspace client={client} mode="app" />)
  await waitFor(() => expect(badge('全部笔记')).toHaveTextContent(/^0$/))
  const draft = newNote({ sourceApp: 'knowledge', title: '新增笔记', content: '正文' })
  const note = await client.create(draft.id, draft)
  fireEvent.click(screen.getByRole('button', { name: '刷新笔记' }))
  await waitFor(() => expect(badge('知识库')).toHaveTextContent(/^1$/))
  fireEvent.click(await screen.findByRole('button', { name: '移至回收站：新增笔记' }))
  await waitFor(() => expect(badge('知识库')).toHaveTextContent(/^0$/))
  expect(badge('全部笔记')).toHaveTextContent(/^0$/)
  expect(badge('回收站')).toHaveTextContent(/^1$/)
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  fireEvent.click(await screen.findByRole('button', { name: '恢复笔记' }))
  await waitFor(() => expect(badge('知识库')).toHaveTextContent(/^1$/))
  expect(badge('回收站')).toHaveTextContent(/^0$/)
  expect((await client.get!(note.id)).deletedAt).toBeNull()
})
it('does not publish old account counts after the client changes', async () => {
  const a = createPreviewNotesClient('account-a'), b = createPreviewNotesClient('account-b')
  let finish!: () => void
  const delayed: NotesClient = { ...a, counts: () => new Promise(resolve => { finish = () => resolve({ all: 99, solutions: 99, knowledge: 0, information: 0, manual: 0, trash: 0 }) }) }
  const view = render(<NotesWorkspace client={delayed} mode="app" />)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  const draft = newNote({ sourceApp: 'manual', title: 'B 的记录', content: '正文' }); await b.create(draft.id, draft)
  view.rerender(<NotesWorkspace client={b} mode="app" />)
  await waitFor(() => expect(badge('全部笔记')).toHaveTextContent(/^1$/))
  await act(async () => finish())
  expect(badge('研究报告')).toHaveTextContent(/^0$/)
  expect(badge('个人记录')).toHaveTextContent(/^1$/)
})
it('shows unavailable counts on failure and clears them after access is lost', async () => {
  const client = createPreviewNotesClient('failure')
  const original = client.counts!
  const counts = vi.spyOn(client, 'counts').mockRejectedValue(new Error('offline'))
  render(<NotesWorkspace client={client} mode="app" />)
  await screen.findByText('还没有笔记')
  expect(badge('全部笔记')).toHaveTextContent('—')
  counts.mockImplementation(original)
  fireEvent.click(screen.getByRole('button', { name: '刷新笔记' }))
  await waitFor(() => expect(badge('全部笔记')).toHaveTextContent(/^0$/))
  vi.spyOn(client, 'list').mockRejectedValue(Object.assign(new Error('登录账号已变化'), { status: 403 }))
  fireEvent.click(screen.getByRole('button', { name: '刷新笔记' }))
  await screen.findByRole('alert')
  expect(badge('全部笔记')).toHaveTextContent('—')
})

it('supports existing list-only clients without deriving counts from loaded items', async () => {
  const client = createPreviewNotesClient('list-only')
  const legacy = { ...client, counts: undefined }
  const draft = newNote({ sourceApp: 'information', title: '行业记录', content: '正文' })
  await client.create(draft.id, draft)
  render(<NotesWorkspace client={legacy} mode="app" />)
  await waitFor(() => expect(badge('行业信息')).toHaveTextContent(/^1$/))
  expect(badge('全部笔记')).toHaveTextContent(/^1$/)
})
it('rejects malformed counts and keeps the note list usable', async () => {
  const client = createPreviewNotesClient('malformed')
  vi.spyOn(client, 'counts').mockResolvedValue({ all: undefined } as never)
  render(<NotesWorkspace client={client} mode="app" />)
  await screen.findByText('还没有笔记')
  expect(badge('全部笔记')).toHaveTextContent('—')
})
