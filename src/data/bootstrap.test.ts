import { afterEach, expect, test, vi } from 'vitest'
vi.mock('../api/projects', () => ({ listProjects: vi.fn() }))
vi.mock('../api/subProjects', () => ({ listSubProjects: async () => [] }))
vi.mock('../api/tasks', () => ({ listTasks: async () => ({ items: [] }) }))
vi.mock('../api/taskDependencies', () => ({ listTaskDependencies: async () => [] }))
vi.mock('../api/templates', () => ({ listTemplates: async () => [] }))
vi.mock('../api/users', () => ({ listUsers: async () => [] }))
vi.mock('../api/finances', () => ({ listFinances: async () => [] }))
vi.mock('../api/baselines', () => ({ listBaselines: async () => [] }))
vi.mock('../api/planning', () => ({ planningApi: { calendars: async () => [], capacities: async () => [] } }))
vi.mock('../api/client', () => ({ API_BASE: '/api/v1', USE_API: true, api: { get: async () => ({ data: { businessDate: '2026-11-04', timezone: 'UTC' } }) }, asAPIError: (e: unknown) => ({ detail: String(e) }) }))
import { listProjects } from '../api/projects'
import { refreshAllData } from './bootstrap'
import { projects, TODAY } from '../mock'
import { useDataStore } from '../store/data'

const previous = [...projects]
const dateBefore = TODAY.getTime()
afterEach(() => { projects.splice(0, projects.length, ...previous); TODAY.setTime(dateBefore); vi.clearAllMocks() })
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
