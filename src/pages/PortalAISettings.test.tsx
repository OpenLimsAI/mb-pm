import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import PortalAISettings from './PortalAISettings'
import { createPreviewModelClient } from '../features/solutions/modelSettings'

vi.mock('../components/portal/context', () => ({ usePortalContext: () => ({ user: { id: 'author', username: 'author', displayName: '研究员' }, preview: true, applications: [], refresh: vi.fn(), logout: vi.fn() }) }))
beforeEach(() => { localStorage.clear() })
it('uses the same personal research model storage while keeping preview keys and connection tests disabled', async () => {
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
