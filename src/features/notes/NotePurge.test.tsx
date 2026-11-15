import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import NotesWorkspace from './NotesWorkspace'
import { createPreviewNotesClient } from './client'
import type { NotesClient } from './client'
import { newNote } from './draft'

beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
function badge(name: string) {
  return within(screen.getByRole('navigation')).getByRole('button', { name }).querySelector('.pn-nav-count')!
}
async function fixture(client = createPreviewNotesClient('purge-ui')) {
  const draft = newNote({ title: '回收笔记', content: '不可恢复前需要确认' })
  const note = await client.trash(await client.create(draft.id, draft))
  const view = render(<NotesWorkspace client={client} mode="app" />)
  await screen.findByText('还没有笔记')
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  await screen.findByRole('button', { name: '查看笔记：回收笔记' })
  return { client, note, view }
}
function openConfirmation() {
  fireEvent.click(within(screen.getByRole('region', { name: '笔记列表' })).getByRole('button', { name: '彻底删除：回收笔记' }))
  return screen.getByRole('alertdialog', { name: '彻底删除笔记？' })
}
it('offers trash row actions and cancel-first confirmation; cancel and Escape do not delete', async () => {
  const { client } = await fixture()
  const purge = vi.spyOn(client, 'purge')
  expect(screen.getByRole('button', { name: '恢复笔记：回收笔记' })).toBeInTheDocument()
  const dialog = openConfirmation()
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
  expect(dialog).toHaveTextContent('删除后无法恢复')
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  expect(within(dialog).getByRole('button', { name: '确认彻底删除' })).toHaveFocus()
  fireEvent.keyDown(document, { key: 'Tab' })
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  openConfirmation()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(purge).not.toHaveBeenCalled()
  expect((await client.list({ trashed: true })).total).toBe(1)
})
it('confirms once, blocks duplicate requests, and refreshes the trash list and count', async () => {
  const { client } = await fixture()
  const original = client.purge!
  let complete!: () => void
  const purge = vi.spyOn(client, 'purge').mockImplementation(note => new Promise(resolve => { complete = () => { void original(note).then(resolve) } }))
  const dialog = openConfirmation()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认彻底删除' }))
  expect(within(dialog).getByRole('button', { name: '删除中…' })).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
  fireEvent.click(within(dialog).getByRole('button', { name: '删除中…' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(dialog).toBeInTheDocument()
  expect(purge).toHaveBeenCalledTimes(1)
  await act(async () => complete())
  await screen.findByText('回收站为空')
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '回收笔记' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '撤销移除' })).not.toBeInTheDocument()
  await waitFor(() => expect(badge('回收站')).toHaveTextContent(/^0$/))
  expect((await client.list({ trashed: true })).total).toBe(0)
})
it('keeps the note and confirmation open when deletion fails so the user can retry', async () => {
  const { client } = await fixture()
  const original = client.purge!
  const purge = vi.spyOn(client, 'purge').mockRejectedValueOnce(new Error('知识库检索副本尚未清理完成，请稍后重试彻底删除'))
  const dialog = openConfirmation()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认彻底删除' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('尚未清理完成')
  expect((await client.list({ trashed: true })).total).toBe(1)
  expect(badge('回收站')).toHaveTextContent(/^1$/)
  purge.mockImplementation(original)
  fireEvent.click(within(dialog).getByRole('button', { name: '确认彻底删除' }))
  await screen.findByText('回收站为空')
})
it('does not carry an old account confirmation into another account', async () => {
  const { client, view } = await fixture()
  const oldPurge = vi.spyOn(client, 'purge')
  openConfirmation()
  const next = createPreviewNotesClient('other-account')
  const nextPurge = vi.spyOn(next, 'purge')
  view.rerender(<NotesWorkspace client={next} mode="app" />)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  await screen.findByText('回收站为空')
  expect(oldPurge).not.toHaveBeenCalled()
  expect(nextPurge).not.toHaveBeenCalled()
})
it('ignores an old account purge completion after the account switches', async () => {
  const { client, view } = await fixture()
  const original = client.purge!
  let complete!: () => void
  vi.spyOn(client, 'purge').mockImplementation(note => new Promise(resolve => { complete = () => { void original(note).then(resolve) } }))
  const dialog = openConfirmation()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认彻底删除' }))
  const next = createPreviewNotesClient('other-account')
  const input = newNote({ title: '新账号记录', content: '保留新账号' })
  await next.trash(await next.create(input.id, input))
  view.rerender(<NotesWorkspace client={next} mode="app" />)
  await screen.findByRole('button', { name: '查看笔记：新账号记录' })
  await act(async () => complete())
  expect(screen.getByRole('button', { name: '查看笔记：新账号记录' })).toBeInTheDocument()
  expect(screen.queryByText('笔记已彻底删除，无法恢复。')).not.toBeInTheDocument()
  expect(badge('回收站')).toHaveTextContent(/^1$/)
})
it('does not offer permanent deletion for active notes or unsupported clients', async () => {
  const client = createPreviewNotesClient('active')
  const input = newNote({ title: '使用中的笔记', content: '仍需保留' })
  await client.create(input.id, input)
  const view = render(<NotesWorkspace client={client} mode="app" />)
  await screen.findByRole('button', { name: '查看笔记：使用中的笔记' })
  expect(screen.queryByRole('button', { name: /彻底删除/ })).not.toBeInTheDocument()
  await client.trash((await client.list()).items[0])
  const legacy: NotesClient = { ...client, purge: undefined }
  view.rerender(<NotesWorkspace client={legacy} mode="app" />)
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  await screen.findByRole('button', { name: '查看笔记：使用中的笔记' })
  expect(screen.queryByRole('button', { name: /彻底删除/ })).not.toBeInTheDocument()
})
it('removes a deleted item from the outstanding undo action', async () => {
  const client = createPreviewNotesClient('undo')
  const input = newNote({ title: '回收笔记', content: '个人记录' })
  await client.create(input.id, input)
  render(<NotesWorkspace client={client} mode="app" />)
  fireEvent.click(await screen.findByRole('button', { name: '移至回收站：回收笔记' }))
  await screen.findByRole('button', { name: '撤销移除' })
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  await screen.findByRole('button', { name: '彻底删除：回收笔记' })
  const dialog = openConfirmation()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认彻底删除' }))
  await screen.findByText('回收站为空')
  expect(screen.queryByRole('button', { name: '撤销移除' })).not.toBeInTheDocument()
})
