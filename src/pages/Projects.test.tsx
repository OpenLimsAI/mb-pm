import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test } from 'vitest'
import Projects from './Projects'
import { TopBar } from '../components/layout/TopBar'
import { projects, subProjects, tasks, users } from '../mock'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import type { Project, SubProject, Task } from '../types'

const original = { projects: [...projects], subProjects: [...subProjects], tasks: [...tasks] }
const first: Project = { ...projects[0], id: 'workspace-a', code: 'WS-A', name: '工艺验证项目', description: '工艺资料', ownerId: 'u2' }
const second: Project = { ...projects[0], id: 'workspace-b', code: 'WS-B', name: '分析方法项目', description: '分析资料', ownerId: 'u2' }
const sub: SubProject = { ...subProjects[0], id: 'workspace-sub-a', projectId: first.id }
const task: Task = { ...tasks[0], id: 'workspace-task-a', name: '验证资料齐套', subProjectId: sub.id, status: '进行中', plannedEnd: '2026-11-06', isMilestone: true }

beforeEach(() => {
  projects.splice(0, projects.length, { ...first }, { ...second })
  subProjects.splice(0, subProjects.length, { ...sub }, { ...sub, id: 'workspace-sub-b', projectId: second.id })
  tasks.splice(0, tasks.length,
    { ...task },
    { ...task, id: 'workspace-task-b', name: '分析方法确认', subProjectId: 'workspace-sub-b', plannedEnd: '2026-11-12' },
    { ...task, id: 'workspace-task-verified', name: '已验证里程碑', status: '已验证', plannedEnd: '2026-10-01' },
  )
  useAuth.setState({ currentUser: { ...users[0], role: 'admin' }, status: 'ready' })
  useDataStore.setState({ mode: 'mock', version: 0 })
})

afterEach(() => {
  projects.splice(0, projects.length, ...original.projects)
  subProjects.splice(0, subProjects.length, ...original.subProjects)
  tasks.splice(0, tasks.length, ...original.tasks)
  useAuth.setState({ currentUser: null, status: 'loading' })
})

function renderProjects() {
  return render(<MemoryRouter initialEntries={['/projects']}><Routes><Route path="/projects" element={<><TopBar /><Projects /></>} /></Routes></MemoryRouter>)
}

function detail() { return within(screen.getByRole('region', { name: '选中项目详情' })) }

test('默认工作台支持项目与详情联动，完整项目入口跟随选择且排除已验证里程碑', () => {
  renderProjects()
  expect(screen.getByRole('button', { name: '工作台' })).toHaveAttribute('aria-pressed', 'true')
  expect(detail().getByRole('heading', { name: first.name })).toBeInTheDocument()
  expect(detail().queryByText('已验证里程碑')).not.toBeInTheDocument()
  expect(detail().getByRole('link', { name: '打开完整项目' })).toHaveAttribute('href', '/projects/workspace-a')

  fireEvent.click(screen.getByRole('button', { name: '查看 WS-B 分析方法项目' }))
  expect(detail().getByRole('heading', { name: second.name })).toBeInTheDocument()
  expect(detail().queryByText('验证资料齐套')).not.toBeInTheDocument()
  expect(detail().getByRole('link', { name: '打开完整项目' })).toHaveAttribute('href', '/projects/workspace-b')
})

test('筛选后详情只展示当前可见项目，无结果时不保留已选项目内容', () => {
  renderProjects()
  fireEvent.click(screen.getByRole('button', { name: '查看 WS-B 分析方法项目' }))
  const input = screen.getByPlaceholderText('搜索项目编号、名称、描述…')
  fireEvent.change(input, { target: { value: '工艺资料' } })
  expect(detail().getByRole('heading', { name: first.name })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '查看 WS-B 分析方法项目' })).not.toBeInTheDocument()
  fireEvent.change(input, { target: { value: '不存在的项目' } })
  expect(screen.getByText('没有匹配的项目')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '选中项目详情' })).not.toBeInTheDocument()
})

test('顶栏搜索可更新同一路由的筛选，重置后恢复列表并保留既有视图入口', () => {
  renderProjects()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索项目' }), { target: { value: 'WS-B' } })
  fireEvent.submit(screen.getByRole('search'))
  expect(screen.getByPlaceholderText('搜索项目编号、名称、描述…')).toHaveValue('WS-B')
  expect(detail().getByRole('heading', { name: second.name })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重置' }))
  expect(screen.getByRole('button', { name: '查看 WS-A 工艺验证项目' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '表格' }))
  expect(screen.getByRole('table')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '卡片' }))
  expect(screen.getAllByRole('link').some((link) => link.getAttribute('href') === '/projects/workspace-a')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '矩阵' }))
  expect(screen.getByRole('button', { name: '矩阵' })).toHaveAttribute('aria-pressed', 'true')
})

test('数据刷新更新已选详情，成员身份仍没有项目创建或复制入口', () => {
  useAuth.setState({ currentUser: { ...users[0], role: 'rd' } })
  renderProjects()
  expect(screen.queryByRole('button', { name: '创建项目' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '复制项目' })).not.toBeInTheDocument()
  act(() => {
    projects[0].progress = 91
    tasks[0].status = '已完成'
    useDataStore.getState().bump()
  })
  expect(detail().getByText('91%')).toBeInTheDocument()
  expect(detail().getByText('暂无未完成任务')).toBeInTheDocument()
  expect(detail().getByText('暂无未完成里程碑')).toBeInTheDocument()
})
