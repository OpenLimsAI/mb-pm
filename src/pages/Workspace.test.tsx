import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import Workspace from './Workspace'

describe('workspace application entries', () => {
  it('opens local application previews without a production login jump', () => {
    render(<MemoryRouter><Workspace user={null} applications={[]} preview onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入行业信息' })).toHaveAttribute('href', '/information?preview=1')
    expect(screen.getByRole('link', { name: '进入AI 助手' })).toHaveAttribute('href', '/assistant?preview=1')
    expect(screen.getByRole('link', { name: '进入研究报告' })).toHaveAttribute('href', '/solutions?preview=1')
    expect(screen.getByRole('link', { name: '进入项目管理' })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: '进入我的笔记' })).toHaveAttribute('href', '/notes?preview=1')
    expect(screen.getByRole('link', { name: '进入AI 设置' })).toHaveAttribute('href', '/model-settings?preview=1')
    expect(screen.getByRole('link', { name: '进入回音壁' })).toHaveAttribute('href', '/feedback?preview=1')
    expect(screen.getByRole('link', { name: '进入知识库' })).toHaveAttribute('href', expect.stringContaining(':4322/?preview=1'))
    expect(screen.getByRole('link', { name: '进入知识库' })).not.toHaveAttribute('target')
  })
  it('opens the assistant independently of KB and PM grants', () => {
    render(<MemoryRouter><Workspace user={{ id: 'a', username: 'a', displayName: '同事' }} applications={[{ id: 'assistant', enabled: true }, { id: 'kb', enabled: false }, { id: 'pm', enabled: false }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入AI 助手' })).toHaveAttribute('href', '/assistant')
  })
  it('uses the checked knowledge solution launch route', () => {
    render(<MemoryRouter><Workspace user={{ id: 'person', username: 'reader', displayName: '同事' }} applications={[{ id: 'solutions', enabled: true }, { id: 'kb', enabled: true }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入研究报告' })).toHaveAttribute('href', '/launch/solutions')
    expect(screen.getByRole('link', { name: '进入知识库' })).toHaveAttribute('href', '/launch/kb')
    expect(screen.getByRole('link', { name: '进入知识库' })).not.toHaveAttribute('target')
  })
  it('opens the new work application through the checked launch route', () => {
    render(<MemoryRouter><Workspace user={{ id: 'person', username: 'reader', displayName: '同事' }} applications={[{ id: 'information', enabled: true }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入行业信息' })).toHaveAttribute('href', '/launch/information')
    expect(screen.getByRole('heading', { name: '行业信息' })).toBeInTheDocument()
  })

  it('lists feedback as an application using the checked launch route', () => {
    render(<MemoryRouter><Workspace user={{ id: 'person', username: 'reader', displayName: '同事' }} applications={[{ id: 'feedback', enabled: true }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入回音壁' })).toHaveAttribute('href', '/launch/feedback')
  })
  it('does not offer an active entry when the catalogue denies access', () => {
    render(<MemoryRouter><Workspace user={null} applications={[{ id: 'information', enabled: false, reason: '请刷新登录身份' }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: '进入行业信息' })).not.toBeInTheDocument()
    expect(screen.getByText('请刷新登录身份')).toBeInTheDocument()
  })
  it('groups four knowledge apps in two rows before business and settings', () => {
    const { container } = render(<MemoryRouter><Workspace user={{ id: 'a', username: 'a', displayName: '研究员' }} applications={[]} preview onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect([...container.querySelectorAll('.workspace-category h2')].map(element => element.textContent)).toEqual(['AI 智能版块', '知识信息版块', '业务管理版块', '功能设置版块'])
    const intelligence = screen.getByRole('region', { name: 'AI 智能版块' })
    expect(within(intelligence).getByRole('link', { name: '进入AI 助手' })).toHaveAttribute('href', '/assistant?preview=1')
    const knowledge = screen.getByRole('region', { name: '知识信息版块' })
    expect(within(knowledge).getAllByRole('heading', { level: 3 }).map(element => element.textContent)).toEqual(['研究报告', '我的笔记', '知识库', '行业信息'])
    const business = screen.getByRole('region', { name: '业务管理版块' })
    expect(within(business).getAllByRole('heading', { level: 3 }).map(element => element.textContent)).toEqual(['项目管理', '主数据管理', '回音壁', '人力资源'])
    expect(within(business).getByRole('article', { name: '人力资源' })).toHaveTextContent('待开发')
    expect(within(business).queryByRole('link', { name: /人力资源/ })).not.toBeInTheDocument()
    const settings = screen.getByRole('region', { name: '功能设置版块' })
    expect(within(settings).getAllByRole('heading', { level: 3 }).map(element => element.textContent)).toEqual(['我的设置', 'AI 设置'])
    expect(screen.queryByRole('heading', { name: '版本更新' })).not.toBeInTheDocument()
  })
  it.each([false, true])('shows account management inside business only with its actual grant (%s)', enabled => {
    render(<MemoryRouter><Workspace user={{ id: 'a', username: 'a', displayName: '同事' }} applications={[{ id: 'accounts', enabled }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    const business = screen.getByRole('region', { name: '业务管理版块' })
    expect(!!within(business).queryByRole('link', { name: '进入账号管理' })).toBe(enabled)
    expect(within(screen.getByRole('region', { name: '知识信息版块' })).queryByRole('heading', { name: '账号管理' })).not.toBeInTheDocument()
  })
  it('opens independent personal notes even without a KB grant', () => {
    const user = { id: 'a', username: 'a', displayName: '同事' }
    render(<MemoryRouter><Workspace user={user} applications={[{ id: 'kb', enabled: false }, { id: 'notes', enabled: true }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入我的笔记' })).toHaveAttribute('href', '/notes')
    expect(screen.getByRole('link', { name: '进入我的笔记' })).not.toHaveAttribute('target')
    expect(screen.queryByRole('link', { name: '进入知识库' })).not.toBeInTheDocument()
  })
})
