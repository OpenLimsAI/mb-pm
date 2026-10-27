import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import Workspace from './Workspace'

describe('workspace application entries', () => {
  it('lets development preview enter the two preview applications', () => {
    render(<MemoryRouter><Workspace user={null} applications={[]} preview onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入信息获取' })).toHaveAttribute('href', '/information?preview=1')
    expect(screen.getByRole('link', { name: '进入回音壁' })).toHaveAttribute('href', '/feedback?preview=1')
    expect(screen.getByRole('link', { name: '进入知识报告' })).toHaveAttribute('href', '/solutions?preview=1')
    expect(screen.queryByRole('link', { name: '进入项目管理' })).not.toBeInTheDocument()
  })
  it('uses the checked knowledge solution launch route', () => {
    render(<MemoryRouter><Workspace user={{ id: 'person', username: 'reader', displayName: '同事' }} applications={[{ id: 'solutions', enabled: true }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入知识报告' })).toHaveAttribute('href', '/launch/solutions')
  })
  it('opens the new work application through the checked launch route', () => {
    render(<MemoryRouter><Workspace user={{ id: 'person', username: 'reader', displayName: '同事' }} applications={[{ id: 'information', enabled: true }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入信息获取' })).toHaveAttribute('href', '/launch/information')
    expect(screen.getByRole('heading', { name: '信息获取' })).toBeInTheDocument()
  })

  it('lists feedback as an application using the checked launch route', () => {
    render(<MemoryRouter><Workspace user={{ id: 'person', username: 'reader', displayName: '同事' }} applications={[{ id: 'feedback', enabled: true }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '进入回音壁' })).toHaveAttribute('href', '/launch/feedback')
  })
  it('does not offer an active entry when the catalogue denies access', () => {
    render(<MemoryRouter><Workspace user={null} applications={[{ id: 'information', enabled: false, reason: '请刷新登录身份' }]} onRefresh={vi.fn()} onLogout={vi.fn()} /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: '进入信息获取' })).not.toBeInTheDocument()
    expect(screen.getByText('请刷新登录身份')).toBeInTheDocument()
  })
})
