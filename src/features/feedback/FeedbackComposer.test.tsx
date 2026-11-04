import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { server } from '../../test/setup'
import FeedbackComposer from './FeedbackComposer'
import { deleteDraft, loadDraft, saveDraft } from './drafts'
import type { FeedbackItem } from './shared'

vi.mock('./drafts', () => ({ loadDraft: vi.fn(), saveDraft: vi.fn(), deleteDraft: vi.fn() }))
const originalUrl = URL
const created: FeedbackItem = { id: 'new-issue', number: 'FB-0012', category: 'bug', application: 'kb', description: '知识库页面异常', status: 'open', author_name: '报告人', created_at: '2026-11-04T12:00:00Z', images: [], can_delete: true, workflow_version: 2 }
const source = { application: 'kb' as const, path: '/#research', browser: 'Test Browser', captured_at: '2026-11-04T12:00:00.000Z' }
const createdCallback = vi.fn()
const closeCallback = vi.fn()
const props = { preview: false, userName: '报告人', namespace: 'issuer-person-A', source, onCreated: createdCallback, onClose: closeCallback, onError: () => '提交失败，请重试。' }

beforeEach(() => {
  createdCallback.mockClear(); closeCallback.mockClear()
  vi.mocked(loadDraft).mockReset().mockResolvedValue(null)
  vi.mocked(saveDraft).mockReset().mockResolvedValue(true)
  vi.mocked(deleteDraft).mockReset().mockResolvedValue()
  vi.stubGlobal('URL', class extends originalUrl { static createObjectURL() { return 'blob:draft-image' } static revokeObjectURL() {} })
  server.use(http.post('*/api/v1/feedback/similar', () => HttpResponse.json({ items: [] })))
})
afterEach(() => { vi.unstubAllGlobals() })

it('submits the source context and structured bug template alongside the normal description', async () => {
  let submitted: Record<string, FormDataEntryValue> | undefined
  server.use(http.post('*/api/v1/feedback', async ({ request }) => {
    submitted = Object.fromEntries(await request.formData())
    return HttpResponse.json(created, { status: 201 })
  }))
  render(<FeedbackComposer {...props} />)
  expect(screen.getByLabelText('所属应用')).toHaveValue('kb')
  expect(screen.getByRole('complementary', { name: '问题发生位置' })).toHaveTextContent('/#research')
  await userEvent.type(screen.getByLabelText(/问题或建议/), created.description)
  await userEvent.type(screen.getByLabelText('复现步骤'), '打开资料后切换页签。')
  await userEvent.type(screen.getByLabelText('期望结果'), '显示新页内容。')
  await userEvent.type(screen.getByLabelText('实际结果'), '显示旧页内容。')
  await userEvent.click(screen.getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(createdCallback).toHaveBeenCalledWith(created, []))
  expect(submitted).toMatchObject({ application: 'kb', category: 'bug', description: created.description, steps_to_reproduce: '打开资料后切换页签。', expected_result: '显示新页内容。', actual_result: '显示旧页内容。' })
  expect(JSON.parse(String(submitted?.source_context))).toEqual(source)
  expect(deleteDraft).toHaveBeenCalledWith('issuer-person-A', 'compose')
})

it('closes an untouched source-prefilled composer without creating or discarding a draft', async () => {
  render(<FeedbackComposer {...props} />)
  expect(screen.getByLabelText('所属应用')).toHaveValue('kb')
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(closeCallback).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog', { name: '放弃这条反馈？' })).not.toBeInTheDocument()
  expect(saveDraft).not.toHaveBeenCalled()
  expect(deleteDraft).not.toHaveBeenCalled()
})

it('sends the feature scenario and benefit without leaking hidden bug-template fields', async () => {
  let submitted: Record<string, FormDataEntryValue> | undefined
  server.use(http.post('*/api/v1/feedback', async ({ request }) => {
    submitted = Object.fromEntries(await request.formData())
    return HttpResponse.json({ ...created, category: 'feature' }, { status: 201 })
  }))
  render(<FeedbackComposer {...props} />)
  await userEvent.type(screen.getByLabelText('复现步骤'), '不再适用的步骤')
  await userEvent.click(screen.getByRole('button', { name: /新功能建议/ }))
  await userEvent.type(screen.getByLabelText(/问题或建议/), '希望支持按应用归类')
  await userEvent.type(screen.getByLabelText('希望解决的问题'), '不同应用问题混杂。')
  await userEvent.type(screen.getByLabelText('预期收益'), '更快找到负责人。')
  await userEvent.click(screen.getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(createdCallback).toHaveBeenCalled())
  expect(submitted).toMatchObject({ category: 'feature', problem_to_solve: '不同应用问题混杂。', expected_benefit: '更快找到负责人。' })
  expect(submitted).not.toHaveProperty('steps_to_reproduce')
})

it('shows similar feedback as optional links without posting or merging the new draft', async () => {
  let query: unknown
  let posts = 0
  server.use(
    http.post('*/api/v1/feedback/similar', async ({ request }) => { query = await request.json(); return HttpResponse.json({ items: [{ ...created, id: 'existing', number: 'FB-0009', description: '类似的旧反馈', similarity_score: 0.8 }] }) }),
    http.post('*/api/v1/feedback', () => { posts++; return HttpResponse.json(created, { status: 201 }) }),
  )
  render(<FeedbackComposer {...props} />)
  await userEvent.type(screen.getByLabelText(/问题或建议/), '知识库页面异常')
  await userEvent.click(screen.getByRole('button', { name: '查找相似反馈' }))
  const match = await screen.findByRole('link', { name: /FB-0009.*类似的旧反馈/ })
  expect(match).toHaveAttribute('href', '/feedback?feedback=existing')
  expect(match).toHaveAttribute('target', '_blank')
  expect(query).toEqual({ description: '知识库页面异常', application: 'kb' })
  expect(posts).toBe(0)
  expect(screen.getByLabelText(/问题或建议/)).toHaveValue('知识库页面异常')
})

it('automatically looks for similar reports before submission without claiming an exact match', async () => {
  let payload: unknown
  let creates = 0
  server.use(
    http.post('*/api/v1/feedback/similar', async ({ request }) => { payload = await request.json(); return HttpResponse.json({ items: [{ ...created, id: 'existing-auto', number: 'FB-0010', description: '可能相关的旧反馈', similarity_score: 0.6 }] }) }),
    http.post('*/api/v1/feedback', () => { creates++; return HttpResponse.json(created) }),
  )
  render(<FeedbackComposer {...props} />)
  await userEvent.type(screen.getByLabelText(/问题或建议/), '连续切换知识库之后资料列表没有更新')
  expect(await screen.findByRole('link', { name: /FB-0010.*可能相关的旧反馈/ })).toBeInTheDocument()
  expect(payload).toEqual({ description: '连续切换知识库之后资料列表没有更新', application: 'kb' })
  expect(creates).toBe(0)
})

it('ends an aborted similar search when the description becomes short again', async () => {
  let release: (() => void) | undefined
  let started = false
  server.use(http.post('*/api/v1/feedback/similar', async () => {
    started = true
    await new Promise<void>(resolve => { release = resolve })
    return HttpResponse.json({ items: [{ ...created, id: 'stale', description: '过时查询的结果' }] })
  }))
  render(<FeedbackComposer {...props} />)
  const description = screen.getByLabelText(/问题或建议/)
  await userEvent.type(description, '连续切换知识库之后资料列表没有更新')
  await waitFor(() => expect(started).toBe(true))
  await userEvent.clear(description)
  await userEvent.type(description, '新问题')
  release?.()
  await waitFor(() => expect(screen.getByRole('button', { name: '查找相似反馈' })).toBeEnabled())
  expect(screen.queryByText(/过时查询的结果/)).not.toBeInTheDocument()
})

it('restores an identity-scoped draft and screenshot only after the user chooses recovery', async () => {
  const savedImage = new File(['image'], 'draft.png', { type: 'image/png' })
  vi.mocked(loadDraft).mockResolvedValue({ value: { application: 'pm', category: 'bug', description: '刷新前未提交的描述', structure: { steps_to_reproduce: '原步骤' }, source: { ...source, application: 'pm', path: '/projects/p-1' } }, files: [savedImage], savedAt: '2026-11-04T12:00:00.000Z' })
  render(<FeedbackComposer {...props} />)
  expect(await screen.findByRole('button', { name: '恢复草稿' })).toBeInTheDocument()
  expect(screen.getByLabelText(/问题或建议/)).toHaveValue('')
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(loadDraft).toHaveBeenCalledWith('issuer-person-A', 'compose')
  await userEvent.click(screen.getByRole('button', { name: '恢复草稿' }))
  expect(screen.getByLabelText(/问题或建议/)).toHaveValue('刷新前未提交的描述')
  expect(screen.getByLabelText('所属应用')).toHaveValue('pm')
  expect(screen.getByLabelText('复现步骤')).toHaveValue('原步骤')
  expect(screen.getByRole('img', { name: '已添加图片 draft.png' })).toBeInTheDocument()
})

it('autosaves the draft under the authenticated namespace and preserves it after a failed submit', async () => {
  server.use(http.post('*/api/v1/feedback', () => HttpResponse.json({ detail: '暂时不可用' }, { status: 503 })))
  render(<FeedbackComposer {...props} />)
  await userEvent.type(screen.getByLabelText(/问题或建议/), '需要保留的说明')
  await waitFor(() => expect(saveDraft).toHaveBeenCalledWith('issuer-person-A', 'compose', expect.objectContaining({ application: 'kb', description: '需要保留的说明' }), []), { timeout: 2000 })
  await userEvent.click(screen.getByRole('button', { name: '提交反馈' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('提交失败')
  expect(screen.getByLabelText(/问题或建议/)).toHaveValue('需要保留的说明')
  expect(deleteDraft).not.toHaveBeenCalled()
})

it('uses a new request key when a failed submission replaces an image with identical file metadata', async () => {
  const keys: string[] = []
  server.use(http.post('*/api/v1/feedback', async ({ request }) => { const body = await request.text(); keys.push(body.match(/name="request_id"\r\n\r\n([^\r]+)/)?.[1] || ''); return HttpResponse.json({ detail: 'temporary' }, { status: 503 }) }))
  render(<FeedbackComposer {...props} />)
  await userEvent.type(screen.getByLabelText(/问题或建议/), '新截图补充')
  await userEvent.upload(screen.getByLabelText('添加图片'), new File(['a'], 'same.png', { type: 'image/png', lastModified: 123 }))
  await userEvent.click(screen.getByRole('button', { name: '提交反馈' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('提交失败')
  await userEvent.click(screen.getByRole('button', { name: '移除图片 same.png' }))
  await userEvent.upload(screen.getByLabelText('添加图片'), new File(['b'], 'same.png', { type: 'image/png', lastModified: 123 }))
  await userEvent.click(screen.getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(keys).toHaveLength(2))
  expect(keys[0]).toBeTruthy()
  expect(keys[1]).not.toBe(keys[0])
})

it('keeps a dirty draft on explicit close instead of treating it as a submitted feedback', async () => {
  render(<FeedbackComposer {...props} />)
  await userEvent.type(screen.getByLabelText(/问题或建议/), '稍后继续')
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  const dialog = screen.getByRole('dialog', { name: '放弃这条反馈？' })
  await userEvent.click(within(dialog).getByRole('button', { name: '保留草稿并关闭' }))
  await waitFor(() => expect(closeCallback).toHaveBeenCalledTimes(1))
  expect(saveDraft).toHaveBeenCalledWith('issuer-person-A', 'compose', expect.objectContaining({ description: '稍后继续' }), [])
  expect(createdCallback).not.toHaveBeenCalled()
  expect(deleteDraft).not.toHaveBeenCalled()
})
