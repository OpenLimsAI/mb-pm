import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'

vi.mock('../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), USE_API: true }))

const NativeURL = URL
const viewer = { id: 'person', username: 'reader', display_name: '李同事' }
const existingItem = { id: 'old', category: 'bug', description: '列表加载缓慢', status: 'fixed', author_name: '王同事', created_at: '2026-10-26T12:00:00Z', images: [], can_delete: false }
const newItem = { id: 'abc', category: 'feature', description: '建议增加筛选', status: 'open', author_name: '李同事', created_at: '2026-10-27T12:00:00Z', images: ['img1'], can_delete: true, can_manage: true, workflow_version: 2, number: 'FB-0123' }

beforeEach(() => {
  server.use(
    http.get('*/api/v1/feedback/people', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/feedback/:id/activities', () => HttpResponse.json({ items: [], next_cursor: null })),
    http.get('*/api/v1/feedback/:id', ({ params }) => HttpResponse.json(params.id === 'abc' ? newItem : existingItem)),
    http.post('*/api/v1/feedback/:id/read', ({ params }) => HttpResponse.json(params.id === 'abc' ? newItem : existingItem)),
  )
  let imageNumber = 0
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL() { return `blob:preview-${++imageNumber}` }
    static revokeObjectURL() {}
  })
})
afterEach(() => {
  usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false })
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
})

function mountFeedback(enabled = true, search = '') {
  server.use(http.get('*/api/v1/portal/me', () => HttpResponse.json({ user: viewer, applications: [{ id: 'feedback', enabled }] })))
  window.history.replaceState({}, '', '/feedback' + search)
  render(<App />)
}

async function openComposer(application = 'pm') {
  const button = (await screen.findAllByRole('button', { name: '提交反馈' }))[0]
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  const dialog = screen.getByRole('dialog')
  if (application) await userEvent.selectOptions(within(dialog).getByLabelText(/所属应用/), application)
  return dialog
}

it('opens the requested composer after loading, then closes it without reopening on refresh', async () => {
  server.use(http.get('*/api/v1/feedback', () => HttpResponse.json([existingItem])))
  mountFeedback(true, '?compose=1&keep=1')
  const dialog = await screen.findByRole('dialog', { name: '提交反馈' })
  // Dialog insertion can precede the passive effect that moves focus into it.
  await waitFor(() => expect(within(dialog).getByLabelText(/问题或建议/)).toHaveFocus())
  await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(window.location.search).toBe('?keep=1')
})

it('waits through a failed load and opens the requested composer after retry', async () => {
  let requests = 0
  server.use(http.get('*/api/v1/feedback', () => ++requests === 1
    ? HttpResponse.json({ detail: '稍后重试' }, { status: 503 })
    : HttpResponse.json([])))
  mountFeedback(true, '?compose=1')
  expect(await screen.findByRole('alert')).toHaveTextContent('稍后重试')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByRole('dialog', { name: '提交反馈' })).toBeInTheDocument()
})

it('pastes a screenshot into the composer and sends it with the feedback', async () => {
  let multipart = ''
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([])),
    http.post('*/api/v1/feedback', async ({ request }) => {
      multipart = await request.text()
      return HttpResponse.json(newItem, { status: 201 })
    }),
  )
  mountFeedback(true, '?compose=1')
  const dialog = await screen.findByRole('dialog', { name: '提交反馈' })
  const description = within(dialog).getByLabelText(/问题或建议/)
  await userEvent.selectOptions(within(dialog).getByLabelText(/所属应用/), 'kb')
  const screenshot = new File(['screenshot'], 'screenshot.png', { type: 'image/png' })
  fireEvent.paste(description, { clipboardData: { items: [{ kind: 'file', type: screenshot.type, getAsFile: () => screenshot }] } })
  expect(within(dialog).getByRole('img', { name: '已添加图片 screenshot.png' })).toBeInTheDocument()
  await userEvent.type(description, '截图中的问题')
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(multipart).toContain('name="images"')
  expect(multipart).toContain('Content-Type: image/png')
  expect(window.location.search).toBe('')
})

it('validates pasted images and leaves normal text pasting unchanged', async () => {
  server.use(http.get('*/api/v1/feedback', () => HttpResponse.json([])))
  mountFeedback(true, '?compose=1')
  const dialog = await screen.findByRole('dialog', { name: '提交反馈' })
  const description = within(dialog).getByLabelText(/问题或建议/)
  const screenshot = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
  fireEvent.paste(description, { clipboardData: { items: [{ kind: 'file', type: screenshot.type, getAsFile: () => screenshot }] } })
  expect(within(dialog).getByRole('alert')).toHaveTextContent('5 MB')
  expect(within(dialog).getByRole('button', { name: '提交反馈' })).toBeDisabled()
  expect(within(dialog).queryByRole('img')).not.toBeInTheDocument()
  expect(fireEvent.paste(description, { clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] } })).toBe(true)
})

it('submits a new feature with an image, makes it visible despite previous filters, and updates its status', async () => {
  let multipart = ''
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([existingItem])),
    http.post('*/api/v1/feedback', async ({ request }) => {
      multipart = await request.text()
      return HttpResponse.json(newItem, { status: 201 })
    }),
    http.post('*/api/v1/feedback/abc/claim', () => HttpResponse.json({ ...newItem, status: 'in_progress', assignee_id: 'person', assignee_name: '李同事' })),
  )
  mountFeedback()
  expect(await screen.findByRole('heading', { name: '回音壁', level: 1 })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
  expect(await screen.findByText('列表加载缓慢')).toBeInTheDocument()
  await userEvent.selectOptions(screen.getByLabelText('状态'), 'fixed')
  await userEvent.selectOptions(screen.getByLabelText('分类'), 'bug')
  await userEvent.type(screen.getByLabelText('搜索反馈'), '加载缓慢')
  const dialog = await openComposer()
  await userEvent.click(within(dialog).getByRole('button', { name: /新功能建议/ }))
  await userEvent.type(within(dialog).getByLabelText(/问题或建议/), '建议增加筛选')
  await userEvent.upload(within(dialog).getByLabelText('添加图片'), new File(['image'], 'screen.png', { type: 'image/png' }))
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(multipart).toContain('name="category"')
  expect(multipart).toContain('feature')
  expect(multipart).toContain('建议增加筛选')
  expect(multipart).toContain('name="images"')
  expect(multipart).toContain('Content-Type: image/png')
  const row = (await screen.findByText('建议增加筛选')).closest('article')!
  expect(within(row).getByRole('img')).toHaveAttribute('src', '/api/v1/feedback/images/img1')
  await userEvent.click(within(row).getByRole('button', { name: /回复与进展/ }))
  const progress = screen.getByRole('dialog', { name: '反馈详情' })
  await userEvent.click(within(progress).getByRole('button', { name: '我来处理' }))
  expect(await within(progress).findByText('处理信息已保存。')).toBeInTheDocument()
  await waitFor(() => expect(within(progress).getByRole('button', { name: '关闭详情' })).toBeEnabled())
  await userEvent.click(within(progress).getByRole('button', { name: '关闭详情' }))
  expect(await within(row).findByText('处理中')).toBeInTheDocument()
  expect(within(row).queryByRole('button', { name: '标记为已修复' })).not.toBeInTheDocument()
})

it('lets a user remove one selected image before submitting', async () => {
  let imageCount = 0
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([])),
    http.post('*/api/v1/feedback', async ({ request }) => {
      const body = await request.text()
      imageCount = (body.match(/name="images"/g) || []).length
      return HttpResponse.json({ ...newItem, category: 'bug', images: ['img1'] }, { status: 201 })
    }),
  )
  mountFeedback()
  const dialog = await openComposer()
  await userEvent.type(within(dialog).getByLabelText(/问题或建议/), '上传问题截图')
  await userEvent.upload(within(dialog).getByLabelText('添加图片'), [
    new File(['one'], 'first.png', { type: 'image/png' }),
    new File(['two'], 'second.png', { type: 'image/png' }),
  ])
  expect(within(dialog).getByRole('button', { name: '移除图片 first.png' })).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '移除图片 first.png' }))
  expect(within(dialog).queryByRole('button', { name: '移除图片 first.png' })).not.toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: '移除图片 second.png' })).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(imageCount).toBe(1)
})


it('does not submit silently after rejecting an oversized image', async () => {
  let posts = 0
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([])),
    http.post('*/api/v1/feedback', () => { posts++; return HttpResponse.json({ ...newItem, images: ['img1'] }, { status: 201 }) }),
  )
  mountFeedback()
  const dialog = await openComposer()
  await userEvent.type(within(dialog).getByLabelText(/问题或建议/), '上传问题截图')
  await userEvent.upload(within(dialog).getByLabelText('添加图片'), new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' }))
  expect(within(dialog).getByRole('alert')).toHaveTextContent('5 MB')
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  expect(posts).toBe(0)
  expect(within(dialog).getByRole('alert')).toHaveTextContent('5 MB')
  await userEvent.upload(within(dialog).getByLabelText('添加图片'), new File(['valid'], 'small.png', { type: 'image/png' }))
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(posts).toBe(1)
})


it('allows explicitly ignoring an image that could not be added', async () => {
  let imageCount = -1
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([])),
    http.post('*/api/v1/feedback', async ({ request }) => {
      imageCount = ((await request.text()).match(/name="images"/g) || []).length
      return HttpResponse.json({ ...newItem, images: [] }, { status: 201 })
    }),
  )
  mountFeedback()
  const dialog = await openComposer()
  await userEvent.type(within(dialog).getByLabelText(/问题或建议/), '问题说明')
  await userEvent.upload(within(dialog).getByLabelText('添加图片'), new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' }))
  expect(within(dialog).getByRole('button', { name: '提交反馈' })).toBeDisabled()
  await userEvent.click(within(dialog).getByRole('button', { name: '忽略未添加的图片' }))
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(imageCount).toBe(0)
})

it('shows a load error instead of an empty state and retries successfully', async () => {
  let requests = 0
  server.use(http.get('*/api/v1/feedback', () => {
    requests += 1
    return requests === 1 ? HttpResponse.json({ detail: '反馈服务暂时不可用' }, { status: 503 }) : HttpResponse.json([existingItem])
  }))
  mountFeedback()
  expect(await screen.findByRole('alert')).toHaveTextContent('反馈服务暂时不可用')
  expect(screen.getByRole('button', { name: '提交反馈' })).toBeDisabled()
  expect(screen.queryByText(/暂无反馈，欢迎提交第一条/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /重试|重新加载/ }))
  expect(await screen.findByText('列表加载缓慢')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '提交反馈' })).toBeEnabled()
  expect(requests).toBe(2)
})

it('keeps the existing status when the server rejects a change', async () => {
  const open = { ...existingItem, status: 'open', can_manage: true, workflow_version: 2 }
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([open])),
    http.get('*/api/v1/feedback/old', () => HttpResponse.json(open)),
    http.post('*/api/v1/feedback/old/read', () => HttpResponse.json(open)),
    http.post('*/api/v1/feedback/old/claim', () => HttpResponse.json({ detail: '状态更新失败' }, { status: 503 })),
  )
  mountFeedback()
  const row = (await screen.findByText('列表加载缓慢')).closest('article')!
  await userEvent.click(within(row).getByRole('button', { name: /回复与进展/ }))
  const progress = screen.getByRole('dialog', { name: '反馈详情' })
  await userEvent.click(within(progress).getByRole('button', { name: '我来处理' }))
  expect(await within(progress).findByRole('alert')).toHaveTextContent('状态更新失败')
  expect(within(row).getByText('待处理')).toBeInTheDocument()
  expect(within(progress).getByRole('button', { name: '我来处理' })).toBeEnabled()
})

it('does not request feedback data when the application is unavailable', async () => {
  let calls = 0
  server.use(http.get('*/api/v1/feedback', () => { calls++; return HttpResponse.json([]) }))
  mountFeedback(false)
  expect(await screen.findByRole('heading', { name: '回音壁暂时不可用' })).toBeInTheDocument()
  expect(calls).toBe(0)
})

it('protects an unfinished draft and restores focus after it is discarded', async () => {
  server.use(http.get('*/api/v1/feedback', () => HttpResponse.json([])))
  mountFeedback()
  const dialog = await openComposer('')
  const draft = within(dialog).getByLabelText(/问题或建议/)
  await waitFor(() => expect(draft).toHaveFocus())
  await userEvent.type(draft, '还没有提交的反馈')
  await userEvent.keyboard('{Escape}')
  expect(within(dialog).getByRole('heading', { name: '放弃这条反馈？' })).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
  expect(within(dialog).getByLabelText(/问题或建议/)).toHaveValue('还没有提交的反馈')
  await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await userEvent.click(within(dialog).getByRole('button', { name: '放弃并关闭' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: '提交反馈' })[0]).toHaveFocus()
})


it('only shows delete for authorized feedback, cancels without a request, and deletes after confirmation', async () => {
  let deletions = 0
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([newItem, existingItem])),
    http.delete('*/api/v1/feedback/abc', () => { deletions++; return new HttpResponse(null, { status: 204 }) }),
  )
  mountFeedback()
  const own = (await screen.findByText('建议增加筛选')).closest('article')!
  const other = screen.getByText('列表加载缓慢').closest('article')!
  expect(within(own).getByRole('button', { name: '删除反馈' })).toBeInTheDocument()
  expect(within(other).queryByRole('button', { name: '删除反馈' })).not.toBeInTheDocument()

  await userEvent.click(within(own).getByRole('button', { name: '删除反馈' }))
  let dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText(/删除后无法恢复，图片、回复和处理记录也会一并删除/)).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(deletions).toBe(0)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByText('建议增加筛选')).toBeInTheDocument()

  await userEvent.click(within(own).getByRole('button', { name: '删除反馈' }))
  dialog = screen.getByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(deletions).toBe(1)
  expect(screen.queryByText('建议增加筛选')).not.toBeInTheDocument()
  expect(screen.getByText('列表加载缓慢')).toBeInTheDocument()
})

it('keeps the feedback and displays an error in the confirmation dialog when deletion fails', async () => {
  let deletions = 0
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([newItem])),
    http.delete('*/api/v1/feedback/abc', () => { deletions++; return HttpResponse.json({ detail: '删除失败，请稍后重试' }, { status: 503 }) }),
  )
  mountFeedback()
  const own = (await screen.findByText('建议增加筛选')).closest('article')!
  await userEvent.click(within(own).getByRole('button', { name: '删除反馈' }))
  const dialog = screen.getByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('删除失败，请稍后重试')
  expect(deletions).toBe(1)
  expect(within(own).getByText('建议增加筛选')).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeEnabled()
})


it('requires an application for the new form and sends it together with description and an image', async () => {
  let posts = 0
  let multipart = ''
  server.use(
    http.get('*/api/v1/feedback', () => HttpResponse.json([])),
    http.post('*/api/v1/feedback', async ({ request }) => {
      posts++; multipart = await request.text()
      return HttpResponse.json({ ...newItem, application: 'kb' }, { status: 201 })
    }),
  )
  mountFeedback()
  const dialog = await openComposer('')
  await userEvent.type(within(dialog).getByLabelText(/问题或建议/), '知识库页面的问题')
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  expect(posts).toBe(0)
  await userEvent.selectOptions(within(dialog).getByLabelText(/所属应用/), 'kb')
  await userEvent.upload(within(dialog).getByLabelText('添加图片'), new File(['image'], 'screen.png', { type: 'image/png' }))
  await userEvent.click(within(dialog).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(posts).toBe(1)
  expect(multipart).toContain('name="application"')
  expect(multipart).toContain('kb')
  expect(multipart).toContain('name="images"')
  expect(within(screen.getByRole('article')).getByText('知识库')).toBeInTheDocument()
})

it('protects the selected application in an unfinished draft and clears it after discard', async () => {
  server.use(http.get('*/api/v1/feedback', () => HttpResponse.json([])))
  mountFeedback()
  let dialog = await openComposer('kb')
  await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(within(dialog).getByRole('heading', { name: '放弃这条反馈？' })).toBeInTheDocument()
  await userEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }))
  expect(within(dialog).getByLabelText(/所属应用/)).toHaveValue('kb')
  await userEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await userEvent.click(within(dialog).getByRole('button', { name: '放弃并关闭' }))
  dialog = await openComposer('')
  expect(within(dialog).getByLabelText(/所属应用/)).toHaveValue('')
})
