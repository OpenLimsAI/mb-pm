import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import PortalAISettings from './PortalAISettings'
import { createPreviewModelClient } from '../features/solutions/modelSettings'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'

const portal = vi.hoisted(() => ({ preview: true }))
vi.mock('../components/portal/context', () => ({ usePortalContext: () => ({ user: { id: 'author', username: 'author', displayName: '研究员' }, preview: portal.preview, applications: [], refresh: vi.fn(), logout: vi.fn() }) }))
vi.mock('../components/settings/AssistantOperationsPanel', () => ({ default: () => null }))
beforeEach(() => { localStorage.clear(); portal.preview = true })
it('keeps preview storage isolated and disables preview keys and connection tests', async () => {
  render(<MemoryRouter initialEntries={['/model-settings?preview=1']}><Routes><Route path="/model-settings" element={<PortalAISettings />} /><Route path="/" element={<p>已返回应用工作台</p>} /></Routes></MemoryRouter>)
  expect(screen.getByRole('heading', { name: 'AI 设置' })).toBeVisible()
  fireEvent.click(await screen.findByRole('button', { name: '添加第一组配置' }))
  fireEvent.change(screen.getByRole('textbox', { name: '配置名称' }), { target: { value: '个人研究模型' } })
  fireEvent.change(screen.getByRole('textbox', { name: '模型名称' }), { target: { value: 'demo-research-model' } })
  expect(screen.getByLabelText('API 密钥')).toBeDisabled()
  expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '保存全部配置' }))
  await screen.findByText('示例配置已保存到本机，未保存密钥，也未调用模型。')
  const saved = await createPreviewModelClient('author:author').get()
  expect(saved.profiles).toMatchObject([{ name: '个人研究模型', model: 'demo-research-model', keySet: false }])
  expect(saved.defaultProfileId).toBe(saved.profiles[0].id)
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.getByText('已返回应用工作台')).toBeVisible())
})

it('describes shared scope and saves through the existing workbench settings API', async () => {
  portal.preview = false
  const requests: string[] = []
  const profile = { id: 'shared:research', name: '组织研究模型', provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'research-model', key_set: true }
  server.use(
    http.get('*/api/v1/solutions/ai/settings', ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      expect(request.credentials).toBe('include')
      return HttpResponse.json({ profiles: [profile], default_profile_id: profile.id, revision: 7 })
    }),
    http.put('*/api/v1/solutions/ai/settings', async ({ request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      expect(request.credentials).toBe('include')
      const body = await request.json() as { profiles: Array<{ id: string; name: string }>; default_profile_id: string; revision: number }
      expect(body).toMatchObject({ default_profile_id: 'shared:research', revision: 7, profiles: [{ id: 'shared:research', name: '共享研究模型' }] })
      expect(body).not.toHaveProperty('owner_id')
      return HttpResponse.json({ profiles: [{ ...profile, name: body.profiles[0].name }], default_profile_id: profile.id, revision: 8 })
    }),
  )
  render(<MemoryRouter><PortalAISettings /></MemoryRouter>)
  expect(screen.getByRole('region', { name: '共享 AI 模型设置' })).toBeInTheDocument()
  expect(screen.getByText(/统一管理组织成员共享的 AI 模型/)).toBeInTheDocument()
  await screen.findByRole('checkbox', { name: '设为组织默认模型' })
  expect(screen.getByText('组织成员共用此配置')).toBeInTheDocument()
  expect(screen.queryByText('仅对当前账号生效')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: '配置名称' }), { target: { value: '共享研究模型' } })
  expect(screen.getByText('修改在保存后对组织成员生效')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存全部配置' }))
  await screen.findByText('共享模型配置已保存。')
  expect(requests).toEqual(['GET /api/v1/solutions/ai/settings', 'PUT /api/v1/solutions/ai/settings'])
})
