import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { server } from '../../test/setup'
import FeedbackEditor from './FeedbackEditor'
import type { FeedbackItem } from './shared'

const item: FeedbackItem = { id: 'issue-1', category: 'bug', application: 'kb', description: '原来描述', status: 'in_progress', author_name: '报告人', created_at: '2026-11-04T12:00:00Z', images: ['image-1', 'image-2'], revision: 8, can_delete: true, can_edit: true, steps_to_reproduce: '原复现步骤' }
const NativeURL = URL
beforeEach(() => {
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL() { return 'blob:new-image' }
    static revokeObjectURL = vi.fn()
  })
})
afterEach(() => vi.unstubAllGlobals())
const failure = () => '反馈已被其他人修改，请刷新后重试。'

it('edits the original with retained image ids, replacement upload and expected revision', async () => {
  let multipart = ''
  const onSaved = vi.fn()
  server.use(http.patch('*/api/v1/feedback/issue-1/content-with-images', async ({ request }) => { multipart = await request.text(); return HttpResponse.json({ ...item, description: '修正后的描述', images: ['image-2', 'image-3'], revision: 9 }) }))
  render(<FeedbackEditor item={item} preview={false} onSaved={onSaved} onClose={vi.fn()} onError={failure} />)
  const dialog = screen.getByRole('dialog', { name: '编辑原反馈' })
  await userEvent.clear(within(dialog).getByLabelText('问题或建议'))
  await userEvent.type(within(dialog).getByLabelText('问题或建议'), '修正后的描述')
  await userEvent.click(within(dialog).getByRole('button', { name: '移除原图片 1' }))
  await userEvent.upload(within(dialog).getByLabelText('添加图片'), new File(['replacement'], 'replacement.png', { type: 'image/png' }))
  expect(within(dialog).getByRole('img', { name: '已添加图片 replacement.png' })).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '保存修改' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 9, images: ['image-2', 'image-3'] })))
  expect(multipart).toContain('name="expected_revision"\r\n\r\n8')
  expect(multipart).toContain('name="keep_images"\r\n\r\n["image-2"]')
  expect(multipart.match(/name="images"/g)).toHaveLength(1)
  expect(multipart).toContain('Content-Type: image/png')
  expect(multipart).toContain('修正后的描述')
})

it('preserves text and image choices after a revision conflict and allows an explicit retry', async () => {
  const onSaved = vi.fn(), onClose = vi.fn()
  let posts = 0
  server.use(http.patch('*/api/v1/feedback/issue-1/content-with-images', () => { posts++; return HttpResponse.json({ detail: 'changed' }, { status: 409 }) }))
  render(<FeedbackEditor item={item} preview={false} onSaved={onSaved} onClose={onClose} onError={failure} />)
  await userEvent.type(screen.getByLabelText('问题或建议'), '追加内容')
  await userEvent.click(screen.getByRole('button', { name: '移除原图片 1' }))
  await userEvent.upload(screen.getByLabelText('添加图片'), new File(['replacement'], 'replacement.png', { type: 'image/png' }))
  await userEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('其他人修改')
  expect(screen.getByLabelText('问题或建议')).toHaveValue('原来描述追加内容')
  expect(screen.getByRole('img', { name: '已添加图片 replacement.png' })).toBeInTheDocument()
  expect(screen.getAllByRole('img', { name: /原图片/ })).toHaveLength(1)
  expect(onSaved).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '保存修改' }))
  await waitFor(() => expect(posts).toBe(2))
})

it('requires explicit discard of dirty edits and traps keyboard focus in its confirmation', async () => {
  const onClose = vi.fn()
  render(<FeedbackEditor item={item} preview={false} onSaved={vi.fn()} onClose={onClose} onError={failure} />)
  await waitFor(() => expect(screen.getByLabelText('问题或建议')).toHaveFocus())
  await userEvent.type(screen.getByLabelText('问题或建议'), '未保存')
  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus()
  await userEvent.tab({ shift: true })
  expect(screen.getByRole('button', { name: '放弃并关闭' })).toHaveFocus()
  await userEvent.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(screen.getByLabelText('问题或建议')).toHaveValue('原来描述未保存')
  expect(onClose).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  await userEvent.click(screen.getByRole('button', { name: '放弃并关闭' }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('clears hidden bug template fields when converting to a feature', async () => {
  let multipart = ''
  server.use(http.patch('*/api/v1/feedback/issue-1/content-with-images', async ({ request }) => { multipart = await request.text(); return HttpResponse.json({ ...item, category: 'feature', revision: 9 }) }))
  render(<FeedbackEditor item={item} preview={false} onSaved={vi.fn()} onClose={vi.fn()} onError={failure} />)
  await userEvent.selectOptions(screen.getByLabelText('编辑反馈分类'), 'feature')
  await userEvent.type(screen.getByLabelText('希望解决的问题'), '每次切换需要重选')
  await userEvent.type(screen.getByLabelText('预期收益'), '减少重复操作')
  await userEvent.click(screen.getByRole('button', { name: '保存修改' }))
  await waitFor(() => expect(multipart).toContain('减少重复操作'))
  expect(multipart).not.toContain('原复现步骤')
  expect(multipart).toContain('name="steps_to_reproduce"\r\n\r\n\r\n')
})
