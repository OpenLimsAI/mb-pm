import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ProjectReadyGate from '../auth/ProjectReadyGate'
import { AppLayout } from './AppLayout'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import type { User } from '../../types'

const identity = vi.hoisted(() => vi.fn())
vi.mock('../../api/auth', () => ({ fetchMe: identity, getLoginUrl: vi.fn(), logoutUrl: '/auth/logout', changePassword: vi.fn() }))
vi.mock('../../api/client', () => ({ asAPIError: (error: unknown) => error }))
vi.mock('../../data/bootstrap', () => ({ bootstrap: vi.fn(), watchIdentity: () => () => {} }))
vi.mock('./Sidebar', () => ({ Sidebar: () => <aside aria-label="项目导航" /> }))
vi.mock('./TopBar', () => ({ TopBar: () => <header>项目管理</header> }))

const user = { id: 'one', username: 'one', displayName: '同事', role: 'rd' } as User

beforeEach(() => {
  vi.clearAllMocks()
  identity.mockResolvedValue(user)
  useAuth.setState({ currentUser: user, status: 'ready', error: null, refreshError: null, mustChangePassword: false })
  useDataStore.setState({ ready: true, mode: 'api', notice: null })
})

function Draft() {
  const [value, setValue] = useState('')
  return <label>未提交的项目说明<input value={value} onChange={event => setValue(event.target.value)} /></label>
}

it('keeps the project draft mounted while identity recovery is shown and retried', async () => {
  render(<MemoryRouter initialEntries={['/projects/one']}><Routes>
    <Route element={<ProjectReadyGate />}><Route element={<AppLayout />}>
      <Route path="projects/:id" element={<Draft />} />
    </Route></Route>
    <Route path="login" element={<p>登录页</p>} />
  </Routes></MemoryRouter>)
  const editor = screen.getByLabelText('未提交的项目说明')
  fireEvent.change(editor, { target: { value: '保留这段尚未保存的说明' } })

  identity.mockRejectedValueOnce({ status: 503, detail: 'temporarily unavailable' })
  await act(async () => { await useAuth.getState().refresh() })
  expect(screen.getByRole('status')).toHaveTextContent('当前页面已保留')
  expect(screen.getByLabelText('未提交的项目说明')).toBe(editor)
  expect(editor).toHaveValue('保留这段尚未保存的说明')
  expect(screen.queryByText('登录页')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '重试身份验证' }))
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  expect(identity).toHaveBeenCalledTimes(2)
  expect(screen.getByLabelText('未提交的项目说明')).toBe(editor)
  expect(editor).toHaveValue('保留这段尚未保存的说明')

  identity.mockRejectedValueOnce({ status: 401, detail: 'session revoked' })
  await act(async () => { await useAuth.getState().refresh() })
  expect(await screen.findByText('登录页')).toBeInTheDocument()
  expect(screen.queryByLabelText('未提交的项目说明')).not.toBeInTheDocument()
})
