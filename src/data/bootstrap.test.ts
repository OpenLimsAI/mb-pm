import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('../api/projects', () => ({ listProjects: vi.fn() }))
vi.mock('../api/subProjects', () => ({ listSubProjects: async () => [] }))
vi.mock('../api/tasks', () => ({ listTasks: vi.fn(), updateTask: vi.fn() }))
vi.mock('../api/taskDependencies', () => ({ listTaskDependencies: async () => [] }))
vi.mock('../api/templates', () => ({ listTemplates: async () => [] }))
vi.mock('../api/users', () => ({ listUsers: async () => [] }))
vi.mock('../api/finances', () => ({ listFinances: vi.fn() }))
vi.mock('../api/baselines', () => ({ listBaselines: async () => [] }))
vi.mock('../api/planning', () => ({ planningApi: { calendars: async () => [], capacities: async () => [] } }))
vi.mock('../api/client', () => ({ API_BASE: '/api/v1', USE_API: true, api: { get: async () => ({ data: { businessDate: '2026-11-04', timezone: 'UTC' } }) }, asAPIError: (e: unknown) => ({ detail: String(e) }) }))
import { listProjects } from '../api/projects'
import { listTasks, updateTask } from '../api/tasks'
import { listFinances } from '../api/finances'
import type { TaskDTO } from '../api/types'
import { refreshAllData, updateTaskProgress, updateTasksBatch } from './bootstrap'
import { projects, tasks, TODAY } from '../mock'
import { useDataStore } from '../store/data'

const previous = [...projects]
const previousTasks = [...tasks]
const dateBefore = TODAY.getTime()
const initialData = useDataStore.getState()
const task = { ...previousTasks[0], collaboratorIds: [], actualStart: null, actualEnd: null, actualEffort: null, notes: null, tags: null, revision: 1 } satisfies TaskDTO
beforeEach(() => {
  vi.mocked(listProjects).mockResolvedValue({ items: [], meta: { total: 0, page: 1, pageSize: 500 } })
  vi.mocked(listTasks).mockResolvedValue({ items: [], meta: { total: 0, page: 1, pageSize: 5000 } })
  vi.mocked(listFinances).mockResolvedValue([])
})
afterEach(() => {
  projects.splice(0, projects.length, ...previous)
  tasks.splice(0, tasks.length, ...previousTasks)
  TODAY.setTime(dateBefore)
  useDataStore.setState(initialData)
  vi.resetAllMocks()
})
function pendingPage() {
  let finish!: (value: Awaited<ReturnType<typeof listProjects>>) => void
  const promise = new Promise<Awaited<ReturnType<typeof listProjects>>>(resolve => { finish = resolve })
  return { promise, finish }
}
test('a late old refresh cannot overwrite data returned after a save', async () => {
  const old = pendingPage(), current = pendingPage()
  vi.mocked(listProjects).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const first = refreshAllData(), second = refreshAllData()
  current.finish({ items: [{ ...previous[0], memberIds: [], description: null, id: 'new-data' }], meta: { total: 1, page: 1, pageSize: 500 } })
  await second
  old.finish({ items: [{ ...previous[0], memberIds: [], description: null, id: 'stale-data' }], meta: { total: 1, page: 1, pageSize: 500 } })
  await first
  expect(projects[0].id).toBe('new-data')
  expect(useDataStore.getState()).toMatchObject({ syncing: false, businessDate: '2026-11-04' })
  expect([TODAY.getFullYear(), TODAY.getMonth() + 1, TODAY.getDate()]).toEqual([2026, 11, 4])
})
test('an old request finishing does not clear a newer request syncing indicator', async () => {
  const old = pendingPage(), current = pendingPage()
  vi.mocked(listProjects).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const first = refreshAllData(), second = refreshAllData()
  old.finish({ items: [], meta: { total: 0, page: 1, pageSize: 500 } }); await first
  expect(useDataStore.getState().syncing).toBe(true)
  current.finish({ items: [], meta: { total: 0, page: 1, pageSize: 500 } }); await second
  expect(useDataStore.getState().syncing).toBe(false)
})

test('project and task synchronization reads the pages beyond the previous size limits', async () => {
  const project = { ...previous[0], memberIds: [], templateId: null, templateVersion: null, description: null }
  const projectRows = Array.from({ length: 501 }, (_, i) => ({ ...project, id: `p-${i}` }))
  const taskRows = Array.from({ length: 5001 }, (_, i) => ({ ...task, id: `t-${i}` }))
  vi.mocked(listProjects).mockImplementation(async ({ page = 1 } = {}) => ({
    items: projectRows.slice((page - 1) * 500, page * 500),
    meta: { page, pageSize: 500, total: 501, snapshot: 'project-order' },
  }))
  vi.mocked(listTasks).mockImplementation(async ({ page = 1 } = {}) => ({
    items: taskRows.slice((page - 1) * 5000, page * 5000),
    meta: { page, pageSize: 5000, total: 5001, snapshot: 'task-order' },
  }))
  await refreshAllData()
  expect(projects).toHaveLength(501)
  expect(tasks).toHaveLength(5001)
  expect(projects.at(-1)?.id).toBe('p-500')
  expect(tasks.at(-1)?.id).toBe('t-5000')
})

test('a changing list is retried and partial pages never replace previous data', async () => {
  vi.mocked(listTasks).mockImplementation(async ({ page = 1 } = {}) => ({
    items: [{ ...task, id: `changed-${page}` }],
    meta: { page, pageSize: 1, total: 2, snapshot: `order-${page}` },
  }))
  await expect(refreshAllData()).rejects.toThrow('同步期间列表发生变化')
  expect(listTasks).toHaveBeenCalledTimes(4)
  expect(tasks).toEqual(previousTasks)
  expect(useDataStore.getState().syncError).toContain('未替换已有数据')
})

test('successful task and batch writes preserve their receipts and revisions when the refresh fails', async () => {
  const second = { ...task, id: 'second-task' }
  vi.mocked(listTasks).mockResolvedValue({ items: [task, second], meta: { total: 2, page: 1, pageSize: 5000 } })
  await refreshAllData()
  useDataStore.setState({ mode: 'api' })
  vi.mocked(listFinances).mockRejectedValue(new Error('财务读取失败'))
  vi.mocked(updateTask).mockResolvedValueOnce({ ...task, progress: 40, revision: 2 })
  await expect(updateTaskProgress(task.id, { progress: 40, expectedRevision: 1 })).resolves.toMatchObject({ revision: 2 })
  expect(tasks[0]).toMatchObject({ progress: 40, revision: 2 })
  expect(useDataStore.getState()).toMatchObject({ writePendingSync: true, syncError: expect.stringContaining('财务读取失败') })

  vi.mocked(updateTask)
    .mockResolvedValueOnce({ ...task, progress: 50, revision: 3 })
    .mockRejectedValueOnce(new Error('版本冲突'))
  await expect(updateTasksBatch([task.id, second.id], { progress: 50 })).resolves.toMatchObject({
    updated: 1, failed: [{ taskId: second.id, detail: expect.stringContaining('版本冲突') }],
  })
  expect(updateTask).toHaveBeenNthCalledWith(2, task.id, { progress: 50, expectedRevision: 2 })
  expect(tasks[0].revision).toBe(3)
})
