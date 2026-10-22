import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Tasks from './Tasks'
import { projects, subProjects, tasks, users } from '../mock'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import type { Project, SubProject, Task } from '../types'

vi.mock('../data/bootstrap', () => ({ updateTasksBatch: vi.fn() }))
vi.mock('../components/task/TaskDrawer', () => ({ TaskDrawer: () => null }))

const original = { projects: [...projects], subProjects: [...subProjects], tasks: [...tasks] }
const baseProject: Project = { ...projects[0], id: 'project-z', code: 'Z-FIRST', name: '第一个项目', ownerId: 'u2' }
const baseSub: SubProject = { ...subProjects[0], id: 'kickoff', projectId: 'project-z', name: '项目启动', sortOrder: 1 }
const baseTask: Task = { ...tasks[0], ownerId: 'u2', collaboratorIds: [], plannedStart: '2026-09-01', plannedEnd: '2026-11-10', isCriticalPath: false, isMilestone: false }

beforeEach(() => {
  projects.splice(0, projects.length, baseProject, { ...baseProject, id: 'project-a', code: 'A-SECOND', name: '第二个项目' })
  subProjects.splice(0, subProjects.length,
    { ...baseSub, id: 'supplier', name: '供应商考察', sortOrder: 2 },
    { ...baseSub, id: 'second-project-sub', projectId: 'project-a' },
    { ...baseSub },
  )
  tasks.splice(0, tasks.length,
    { ...baseTask, id: 'b1', code: 'B-1', name: '第二项目任务', subProjectId: 'second-project-sub', sortOrder: 1 },
    { ...baseTask, id: 'a22', code: 'A-2-2', name: '合同签订', subProjectId: 'supplier', sortOrder: 2, plannedStart: '2026-01-01' },
    { ...baseTask, id: 'a21', code: 'A-2-1', name: '供应商考察选定', subProjectId: 'supplier', sortOrder: 1, ownerId: 'u6' },
    { ...baseTask, id: 'a12', code: 'A-1-2', name: '启动资料准备', subProjectId: 'kickoff', sortOrder: 2, plannedStart: '2026-08-01' },
    { ...baseTask, id: 'a11', code: 'A-1-1', name: '召开项目启动会', subProjectId: 'kickoff', sortOrder: 1, ownerId: 'u6' },
  )
  useAuth.setState({ currentUser: users.find((u) => u.id === 'u2')!, status: 'ready' })
  useDataStore.setState({ mode: 'mock', version: 0 })
})

afterEach(() => {
  projects.splice(0, projects.length, ...original.projects)
  subProjects.splice(0, subProjects.length, ...original.subProjects)
  tasks.splice(0, tasks.length, ...original.tasks)
  useAuth.setState({ currentUser: null, status: 'loading' })
})

function taskNames() {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) => {
    const taskCell = within(row).getAllByRole('cell')[1]
    return taskCell.lastElementChild?.textContent
  })
}

const firstProjectTasks = ['召开项目启动会', '启动资料准备', '供应商考察选定', '合同签订']

test('全局任务连续展示每个项目的完整 WBS 顺序', () => {
  render(<Tasks />)
  expect(taskNames()).toEqual([...firstProjectTasks, '第二项目任务'])
})

test('筛选项目或搜索时保持 WBS 相对顺序，清空后恢复完整顺序', () => {
  render(<Tasks />)
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'project-z' } })
  expect(taskNames()).toEqual(firstProjectTasks)
  fireEvent.change(screen.getByPlaceholderText('搜索任务编号、名称…'), { target: { value: '启动' } })
  expect(taskNames()).toEqual(['召开项目启动会', '启动资料准备'])
  fireEvent.click(screen.getByRole('button', { name: '重置' }))
  expect(taskNames()).toEqual([...firstProjectTasks, '第二项目任务'])
})

test('项目成员仍只看到本人任务，排序不会增加可见范围', () => {
  useAuth.setState({ currentUser: users.find((u) => u.id === 'u6')! })
  render(<Tasks />)
  expect(taskNames()).toEqual(['召开项目启动会', '供应商考察选定'])
})

test('保存子项目排序并同步数据后，任务列表随数据版本更新', () => {
  render(<Tasks />)
  act(() => {
    subProjects.find((s) => s.id === 'kickoff')!.sortOrder = 3
    useDataStore.getState().bump()
  })
  expect(taskNames()).toEqual(['供应商考察选定', '合同签订', '召开项目启动会', '启动资料准备', '第二项目任务'])
})
