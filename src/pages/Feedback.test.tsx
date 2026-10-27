import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { server } from '../test/setup'
import { usePortal } from '../store/portal'

vi.mock('../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), USE_API: true }))

afterEach(() => {
  usePortal.setState({ status: 'loading', user: null, identityNamespace: undefined, applications: [], mustChangePassword: false })
  window.history.replaceState({}, '', '/')
})

it('opens the application through portal identity and submits an image and updates status', async () => {
  let uploaded = false
  server.use(
    http.get('*/api/v1/portal/me', () => HttpResponse.json({ user: { id: 'person', username: 'reader', display_name: '李同事' }, applications: [{ id: 'feedback', enabled: true }] })),
    http.get('*/api/v1/feedback', () => HttpResponse.json([])),
    http.post('*/api/v1/feedback', async ({ request }) => {
      const data = await request.text()
      uploaded = data.includes('name="category"') && data.includes('feature') && data.includes('建议增加筛选') && data.includes('name="images"') && data.includes('Content-Type: image/png')
      return HttpResponse.json({ id: 'abc', category: 'feature', description: '建议增加筛选', status: 'open', author_name: '李同事', created_at: '2026-10-27T12:00:00Z', images: ['img1'] }, { status: 201 })
    }),
    http.patch('*/api/v1/feedback/abc', async ({ request }) => {
      const data = await request.json() as { status: string }
      return HttpResponse.json({ id: 'abc', category: 'feature', description: '建议增加筛选', status: data.status, author_name: '李同事', created_at: '2026-10-27T12:00:00Z', images: ['img1'] })
    }),
  )
  window.history.replaceState({}, '', '/feedback')
  render(<App />)
  expect(await screen.findByRole('heading', { name: '回音壁', level: 1 })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
  await userEvent.selectOptions(screen.getByLabelText('反馈分类'), 'feature')
  await userEvent.type(screen.getByLabelText('问题或建议'), '建议增加筛选')
  await userEvent.upload(screen.getByLabelText('上传图片（可选）'), new File(['image'], 'screen.png', { type: 'image/png' }))
  await userEvent.click(screen.getByRole('button', { name: '提交反馈' }))
  expect(await screen.findByText('反馈已提交，谢谢你的建议。')).toBeInTheDocument()
  expect(uploaded).toBe(true)
  const row = screen.getByText('建议增加筛选').closest('article')!
  expect(within(row).getByRole('img')).toHaveAttribute('src', '/api/v1/feedback/images/img1')
  await userEvent.click(within(row).getByRole('button', { name: '标记为已修复' }))
  expect(await within(row).findByText('已修复')).toBeInTheDocument()
})

it('does not request feedback data when the application is unavailable', async () => {
  let calls = 0
  server.use(
    http.get('*/api/v1/portal/me', () => HttpResponse.json({ user: { id: 'person', username: 'reader', display_name: '同事' }, applications: [{ id: 'feedback', enabled: false }] })),
    http.get('*/api/v1/feedback', () => { calls++; return HttpResponse.json([]) }),
  )
  window.history.replaceState({}, '', '/feedback')
  render(<App />)
  expect(await screen.findByRole('heading', { name: '回音壁暂时不可用' })).toBeInTheDocument()
  expect(calls).toBe(0)
})
