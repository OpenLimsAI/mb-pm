import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import GanttPage from './Gantt'
import { projects, subProjects, tasks, users } from '../mock'
import { useAuth } from '../store/auth'
import type { Project, User } from '../types'

vi.mock('../components/project/Gantt', () => ({
  Gantt: ({ project }: { project: Project }) => (
    <div role="region" aria-label={`单项目甘特图 ${project.name}`} />
  ),
}))
vi.mock('../components/task/TaskDrawer', () => ({ TaskDrawer: () => null }))

const admin: User = {
  id: 'gantt-admin', username: 'gantt-admin', displayName: '管理员', role: 'admin',
  email: '', weeklyAvailableHours: 40, isActive: true, avatarColor: '',
}
const first: Project = {
  id: 'gantt-p1', code: 'GANTT-01', name: '第一项目', ownerId: admin.id,
  productType: '其他', currentStage: 'IND', targetStage: 'Ph3', status: '活跃',
  health: 'green', plannedStart: '2026-11-01', plannedEnd: '2027-01-30',
  progress: 0, templateId: null, templateVersion: null,
}
const second: Project = { ...first, id: 'gantt-p2', code: 'GANTT-02', name: '第二项目' }
const original = {
  projects: [...projects], subProjects: [...subProjects], tasks: [...tasks], users: [...users],
  user: useAuth.getState().currentUser,
}

beforeEach(() => {
  projects.splice(0, projects.length, first, second)
  subProjects.splice(0, subProjects.length)
  tasks.splice(0, tasks.length)
  users.splice(0, users.length, admin)
  useAuth.setState({ currentUser: admin })
})

afterEach(() => {
  projects.splice(0, projects.length, ...original.projects)
  subProjects.splice(0, subProjects.length, ...original.subProjects)
  tasks.splice(0, tasks.length, ...original.tasks)
  users.splice(0, users.length, ...original.users)
  useAuth.setState({ currentUser: original.user })
})

test('管理员进入甘特图默认显示单项目，并可切换项目及多项目视图', () => {
  render(<MemoryRouter><GanttPage /></MemoryRouter>)
  const single = screen.getByRole('button', { name: '单项目视图' })
  const multi = screen.getByRole('button', { name: '多项目视图' })
  expect(single).toHaveAttribute('aria-pressed', 'true')
  expect(multi).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('region', { name: '单项目甘特图 第一项目' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /多项目联合甘特图/ })).not.toBeInTheDocument()

  fireEvent.change(screen.getByRole('combobox'), { target: { value: second.id } })
  expect(screen.getByRole('region', { name: '单项目甘特图 第二项目' })).toBeInTheDocument()

  fireEvent.click(multi)
  expect(multi).toHaveAttribute('aria-pressed', 'true')
  expect(single).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('heading', { name: /多项目联合甘特图/ })).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

  fireEvent.click(single)
  expect(single).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('combobox')).toHaveValue(second.id)
  expect(screen.getByRole('region', { name: '单项目甘特图 第二项目' })).toBeInTheDocument()
})
