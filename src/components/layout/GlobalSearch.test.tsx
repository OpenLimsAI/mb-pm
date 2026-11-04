import { afterEach, expect, test } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { GlobalSearch } from './GlobalSearch'
import { projects, tasks, subProjects, users } from '../../mock'
import { useAuth } from '../../store/auth'

afterEach(() => useAuth.setState({ currentUser: null }))
test('search finds a visible task by owner and links directly to its project', () => {
  useAuth.setState({ currentUser: users.find(u => u.role === 'admin') || { ...users[0], role: 'admin' } })
  const task = tasks.find(t => subProjects.some(s => s.id === t.subProjectId && projects.some(p => p.id === s.projectId)))!
  render(<MemoryRouter><GlobalSearch /></MemoryRouter>)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: task.name } })
  const link = screen.getAllByRole('link').find(a => a.getAttribute('href')?.includes(`task=${encodeURIComponent(task.id)}`))
  expect(link).toBeDefined()
})

test('a member cannot search tasks outside their visible scope', () => {
  useAuth.setState({ currentUser: { ...users[0], id: 'unassigned-test-user', role: 'rd' } })
  render(<MemoryRouter><GlobalSearch /></MemoryRouter>)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: tasks[0].name } })
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.getByText('没有匹配的项目或任务')).toBeInTheDocument()
})
