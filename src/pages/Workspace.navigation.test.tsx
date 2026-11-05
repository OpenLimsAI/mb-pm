import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import PortalLayout from '../components/portal/PortalLayout'
import Workspace from './Workspace'

const user = { id: 'reader', username: 'reader', displayName: '同事' }
const sections = ['AI 智能版块', '知识信息版块', '业务管理版块', '数据管理版块', '功能设置版块']
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
function Home({ preview = false }: { preview?: boolean }) {
  return <Workspace user={user} applications={[]} preview={preview} onRefresh={vi.fn()} onLogout={vi.fn()} />
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})

it.each([false, true])('navigates to each section, focuses it and highlights only its link (preview=%s)', preview => {
  const scroll = vi.fn()
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  render(<MemoryRouter initialEntries={[preview ? '/?preview=1' : '/']}><Home preview={preview} /></MemoryRouter>)
  const nav = within(screen.getByRole('navigation', { name: '门户导航' }))
  expect(nav.getAllByRole('link').map(link => link.textContent)).toEqual(['工作台', ...sections, '使用帮助'])
  for (const label of sections) {
    const link = nav.getByRole('link', { name: label })
    expect(link.getAttribute('href')).toMatch(preview ? /^\/\?preview=1#workspace-/ : /^\/#workspace-/)
    fireEvent.click(link)
    expect(screen.getByRole('region', { name: label })).toHaveFocus()
    expect(link).toHaveAttribute('aria-current', 'location')
    expect(nav.getAllByRole('link').filter(item => item.hasAttribute('aria-current'))).toEqual([link])
    expect(scroll).toHaveBeenLastCalledWith({ block: 'start', behavior: 'smooth' })
  }
  fireEvent.click(nav.getByRole('link', { name: '工作台' }))
  expect(nav.getByRole('link', { name: '工作台' })).toHaveAttribute('aria-current', 'page')
  expect(scroll.mock.instances.at(-1)).toBe(document.getElementById('workspace-top'))
})

it('returns from another portal page and restores section navigation with browser history', () => {
  function Settings() {
    return <PortalLayout user={user} preview><h1>个人账号页</h1></PortalLayout>
  }
  function History() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>后退</button> }
  render(<MemoryRouter initialEntries={['/settings?preview=1']}><History /><Routes><Route path="/settings" element={<Settings />} /><Route path="/" element={<Home preview />} /></Routes></MemoryRouter>)
  fireEvent.click(screen.getByRole('link', { name: '功能设置版块' }))
  expect(screen.getByRole('region', { name: '功能设置版块' })).toHaveFocus()
  fireEvent.click(screen.getByRole('link', { name: 'AI 智能版块' }))
  fireEvent.click(screen.getByRole('button', { name: '后退' }))
  expect(screen.getByRole('region', { name: '功能设置版块' })).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: '后退' }))
  expect(screen.getByRole('heading', { name: '个人账号页' })).toBeVisible()
})

it('opens a section deep link with reduced motion', () => {
  const scroll = vi.fn()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  render(<MemoryRouter initialEntries={['/#workspace-knowledge']}><Home /></MemoryRouter>)
  expect(screen.getByRole('region', { name: '知识信息版块' })).toHaveFocus()
  expect(scroll).toHaveBeenLastCalledWith({ block: 'start', behavior: 'instant' })
})
