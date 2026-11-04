import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import Projects from './Projects'
import { TopBar } from '../components/layout/TopBar'
import { projects, subProjects, tasks, users } from '../mock'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import { projectStorageKey, readProjectNavigation, recordProjectVisit } from '../lib/projectNavigation'
import type { Project, SubProject, Task, User } from '../types'

vi.mock('../components/task/TaskDrawer', () => ({ TaskDrawer: ({ task, onClose }: { task: Task | null; onClose: () => void }) => task ? <div role="dialog" aria-label={task.name}><button onClick={onClose}>关闭任务</button></div> : null }))
vi.mock('../components/projects/CopyProjectDialog', () => ({ CopyProjectDialog: () => null }))
const user: User = { id: 'u1', username: 'test', displayName: '测试负责人', role: 'cmc_lead', email: '', weeklyAvailableHours: 40, isActive: true, avatarColor: '' }
const project: Project = { id: 'p1', code: 'QA-01', name: '质量项目', ownerId: 'u1', productType: '其他', currentStage: '上市后', targetStage: '上市后', status: '活跃', health: 'green', plannedStart: '2026-11-01', plannedEnd: '2027-10-30', progress: 22, templateId: null, templateVersion: null }
const sub: SubProject = { id: 's1', projectId: 'p1', name: '质量研究', stage: '上市后', module: '其他', status: '进行中', progress: 22, sortOrder: 0 }
const task: Task = { id: 't1', code: 'T1', name: '供应商考察', subProjectId: 's1', ownerId: 'u1', status: '阻塞', priority: '中', plannedStart: '2026-11-01', plannedEnd: '2099-11-10', estimatedEffort: 2, progress: 10, isMilestone: false, isCriticalPath: false }
const original = { projects: [...projects], subProjects: [...subProjects], tasks: [...tasks], users: [...users] }
afterEach(() => {
  projects.splice(0, projects.length, ...original.projects)
  subProjects.splice(0, subProjects.length, ...original.subProjects)
  tasks.splice(0, tasks.length, ...original.tasks)
  users.splice(0, users.length, ...original.users)
  useAuth.setState({ currentUser: null, status: 'loading' })
})
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  projects.splice(0, projects.length, project, { ...project, id: 'p2', name: '第二项目', ownerId: 'u2' })
  subProjects.splice(0, subProjects.length, sub)
  tasks.splice(0, tasks.length, task)
  users.splice(0, users.length, user, { ...user, id: 'u2', displayName: '另一负责人' })
  useAuth.setState({ currentUser: user, status: 'ready' })
  useDataStore.setState({ mode: 'api', ready: true })
})
function start(entry = '/projects') {
  return render(<MemoryRouter initialEntries={[entry]}><main><Routes><Route path="/projects" element={<><TopBar /><Projects /></>} /><Route path="/projects/:id" element={<div>项目详情<Link to="/projects">返回项目列表</Link></div>} /></Routes></main></MemoryRouter>)
}
test('first visit defaults to whole-card direct navigation and return preserves search/view', () => {
  start()
  expect(screen.getByRole('button', { name: '卡片' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索项目' }), { target: { value: '质量' } })
  expect(screen.queryByRole('link', { name: '进入项目：第二项目' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: '进入项目：质量项目' }))
  expect(screen.getByText('项目详情')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('link', { name: '返回项目列表' }))
  expect(screen.getByRole('searchbox')).toHaveValue('质量')
  fireEvent.click(screen.getByRole('button', { name: '表格' }))
  expect(screen.getByRole('table')).toBeInTheDocument()
  expect(screen.getByRole('searchbox')).toHaveValue('质量')
})
test('workbench ignores list filters, opens task directly, refreshes counts and retains completed drawer', () => {
  start()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matches' } })
  fireEvent.click(screen.getByRole('button', { name: '工作台' }))
  expect(screen.getByRole('button', { name: /需要关注.*1/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '打开任务：供应商考察' }))
  expect(screen.getByRole('dialog', { name: '供应商考察' })).toBeInTheDocument()
  act(() => { tasks.splice(0, 1, { ...task, status: '已完成' }); useDataStore.getState().bump() })
  expect(screen.getByRole('button', { name: /需要关注.*0/ })).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭任务' }))
  expect(screen.getByText('暂无逾期、延迟或阻塞事项')).toBeInTheDocument()
})
test('preserves all advanced filters and a visible active-filter count while collapsed', () => {
  start()
  fireEvent.click(screen.getByRole('button', { name: '筛选' }))
  fireEvent.change(screen.getByRole('combobox', { name: '状态' }), { target: { value: '已归档' } })
  expect(screen.getByText('没有匹配的项目')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '筛选 (1)' }))
  expect(screen.queryByRole('combobox', { name: '状态' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重置筛选' }))
  expect(screen.getAllByRole('link', { name: /进入项目：/ })).toHaveLength(2)
})
test('account-specific preferences and shortcuts never disclose inaccessible history', () => {
  recordProjectVisit('u1', 'hidden-project')
  localStorage.setItem(projectStorageKey('u2'), JSON.stringify({ page: 'workbench' }))
  start()
  expect(screen.getByRole('button', { name: '卡片' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '工作台' }))
  expect(screen.getByRole('heading', { name: '项目快捷入口' })).toBeInTheDocument()
  expect(screen.queryByText('hidden-project')).not.toBeInTheDocument()
  act(() => { useAuth.setState({ currentUser: { ...user, id: 'u3' } }) })
  expect(screen.getByRole('button', { name: '卡片' })).toBeInTheDocument()
})
test('q search overrides remembered workbench and persists for header return', () => {
  localStorage.setItem(projectStorageKey('u1'), JSON.stringify({ page: 'workbench' }))
  start('/projects?q=质量')
  fireEvent.click(screen.getByRole('link', { name: '进入项目：质量项目' }))
  fireEvent.click(screen.getByRole('link', { name: '返回项目列表' }))
  expect(screen.getByRole('searchbox')).toHaveValue('质量')
})
test('my-task scope uses the current user and both date panels follow the selector', () => {
  tasks.splice(0, 1, { ...task, ownerId: 'u2' })
  start()
  fireEvent.click(screen.getByRole('button', { name: '工作台' }))
  fireEvent.click(screen.getByRole('button', { name: '我的事项' }))
  expect(screen.getByRole('button', { name: /需要关注.*0/ })).toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox', { name: '事项时间范围' }), { target: { value: '7' } })
  expect(within(screen.getByRole('group', { name: '事项类别' })).getAllByText('含今天 · 未来 7 天')).toHaveLength(2)
  expect(screen.getByRole('heading', { name: '近期里程碑' }).parentElement).toHaveTextContent('未来 7 天')
})
test('malformed or unavailable browser settings fall back safely', () => {
  localStorage.setItem(projectStorageKey('u1'), '{')
  expect(readProjectNavigation('u1').view).toBe('cards')
  localStorage.setItem(projectStorageKey('u1'), JSON.stringify({ page: 'bad', horizon: 12, filters: { health: 'invalid' } }))
  expect(readProjectNavigation('u1')).toMatchObject({ page: 'projects', horizon: 30, filters: { health: 'all' } })
})

test('header search updates the same route and member role does not gain management actions', () => {
  useAuth.setState({ currentUser: { ...user, role: 'rd' } })
  start()
  expect(screen.queryByRole('button', { name: '创建项目' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '复制项目' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '工作台' }))
  fireEvent.change(screen.getByRole('textbox', { name: '搜索项目、任务、里程碑或负责人' }), { target: { value: '第二' } })
  fireEvent.submit(screen.getByRole('search'))
  expect(screen.getByRole('searchbox')).toHaveValue('第二')
  expect(screen.getByRole('link', { name: '进入项目：第二项目' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '进入项目：质量项目' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '矩阵' }))
  expect(screen.getByRole('button', { name: '矩阵' })).toHaveAttribute('aria-pressed', 'true')
})
