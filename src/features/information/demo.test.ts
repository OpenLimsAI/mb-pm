import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { InformationSnapshot } from './api'
import { demoMutation, demoSeed, demoStorageKey, demoTick, persistDemo, restoreDemo } from './demo'

const namespace = 'a'.repeat(64)
const storageKey = `mberp:information-demo:v1:http://localhost:5175:${namespace}`
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')

beforeEach(() => {
  // Node 26 exposes an unavailable native localStorage getter in this test host.
  // Engine tests supply only the browser Storage contract; app code is unchanged.
  const entries = new Map<string, string>()
  const storage: Storage = {
    get length() { return entries.size },
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, String(value)) },
    removeItem: key => { entries.delete(key) },
    clear: () => { entries.clear() },
    key: index => [...entries.keys()][index] ?? null,
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor)
})

function createJob(documentIds: string[], parse = true, newFolder?: string) {
  return demoMutation(demoSeed(), '/jobs', {
    sourceId: 'ich', folderId: 'ich-folder', documentIds, parse, newFolder,
  })
}

function finish(data: InformationSnapshot) {
  for (let index = 0; index < 30 && data.jobs.some(job => job.status === 'running'); index++) data = demoTick(data)
  expect(data.jobs.some(job => job.status === 'running')).toBe(false)
  return data
}

function control(data: InformationSnapshot, action: string) {
  return demoMutation(data, `/jobs/${data.jobs[0].id}/control`, { action })
}

test('持久化必须具备有效身份命名空间，不同账号隔离且预览不落盘', () => {
  expect(demoStorageKey(namespace)).toBe(storageKey)
  expect(demoStorageKey('b'.repeat(64))).not.toBe(storageKey)
  for (const invalid of [undefined, '', 'preview', 'a'.repeat(63), '../account', 'z'.repeat(64)]) expect(demoStorageKey(invalid)).toBeNull()
  persistDemo(null, demoSeed())
  expect(window.localStorage.length).toBe(0)
  const first = demoMutation(demoSeed(), '/preferences', { note: '仅甲账号的演示笔记' })
  persistDemo(storageKey, first)
  expect(restoreDemo(storageKey).note).toBe('仅甲账号的演示笔记')
  expect(restoreDemo(demoStorageKey('b'.repeat(64))).note).toBe(demoSeed().note)
})

test('仅归档任务下载失败后重试仍保留未要求解析，不误报已索引', () => {
  let data = finish(createJob(['m9'], false))
  expect(data.jobs[0]).toMatchObject({ parse: false, processed: 1, saved: 0, failed: 1, pending: 0 })
  expect(data.documents.find(doc => doc.id === 'm9')?.versions).toHaveLength(0)
  data = finish(control(data, 'retry'))
  expect(data.jobs[0]).toMatchObject({ parse: false, saved: 1, failed: 0, pending: 0 })
  expect(data.jobs[0].items[0].status).toBe('stored')
  expect(data.documents.find(doc => doc.id === 'm9')).toMatchObject({ status: 'archived', versions: [{ parseStatus: 'not_requested', indexStatus: 'pending' }] })
})

test('仅重试失败项，保存与失败分开计数并保持成功文件及目录成员不重复', () => {
  let data = finish(createJob(['q9', 'q1', 's2', 'e8', 'm7', 'm9'], true, '演示法规'))
  const folderId = data.jobs[0].folderId
  expect(data.jobs[0]).toMatchObject({ processed: 6, saved: 5, failed: 2, pending: 0 })
  expect(data.jobs[0].items.map(item => item.status)).toEqual(['linked', 'ready', 'ready', 'ready', 'parse-failed', 'download-failed'])
  expect(data.documents.filter(doc => doc.folderIds.includes(folderId))).toHaveLength(5)
  const succeeded = structuredClone(data.documents.filter(doc => ['q9', 'q1', 's2', 'e8'].includes(doc.id)))
  data = control(data, 'retry')
  expect(data.jobs[0].items.filter(item => item.status === 'retry-pending').map(item => item.documentId)).toEqual(['m7', 'm9'])
  data = finish(data)
  expect(data.jobs[0]).toMatchObject({ processed: 6, saved: 6, failed: 0, pending: 0 })
  expect(data.documents.filter(doc => ['q9', 'q1', 's2', 'e8'].includes(doc.id))).toEqual(succeeded)
  expect(data.documents.filter(doc => doc.folderIds.includes(folderId))).toHaveLength(6)
  data = demoMutation(data, '/jobs', { sourceId: 'ich', folderId, documentIds: ['q9', 'q1'], parse: true })
  data = finish(data)
  expect(data.jobs[1].items.map(item => item.status)).toEqual(['skipped', 'skipped'])
  expect(data.documents.filter(doc => doc.folderIds.includes(folderId))).toHaveLength(6)
  expect(data.documents.every(doc => new Set(doc.folderIds).size === doc.folderIds.length)).toBe(true)
  expect(data.documents.find(doc => doc.id === 'q9')?.versions).toHaveLength(2)
})

test('暂停不再推进，刷新后运行任务恢复为暂停，继续处理保留已完成进度', () => {
  let data = demoTick(createJob(['q1', 's2'], true, '独立演示目录'))
  expect(data.jobs[0]).toMatchObject({ processed: 1, saved: 1, pending: 1 })
  const paused = control(data, 'pause')
  expect(demoTick(paused)).toBe(paused)
  persistDemo(storageKey, data)
  data = restoreDemo(storageKey)
  expect(data.jobs[0]).toMatchObject({ status: 'paused', processed: 1, saved: 1, pending: 1 })
  expect(demoTick(data)).toBe(data)
  data = finish(control(data, 'resume'))
  expect(data.jobs[0]).toMatchObject({ status: 'completed', processed: 2, saved: 2, pending: 0 })
  expect(data.documents.filter(doc => doc.folderIds.includes(data.jobs[0].folderId))).toHaveLength(2)
})

function replaceAt(value: unknown, path: (string | number)[], replacement: unknown) {
  let cursor = value as Record<string | number, unknown>
  for (const part of path.slice(0, -1)) cursor = cursor[part] as Record<string | number, unknown>
  cursor[path[path.length - 1]] = replacement
}

const malformed: [string, (string | number)[], unknown][] = [
  ['来源范围状态', ['sources', 0, 'scopeStatus', 'Q', 'status'], { invalid: true }],
  ['来源范围错误', ['sources', 0, 'scopeStatus', 'Q', 'error'], { invalid: true }],
  ['来源范围数组', ['sources', 0, 'scopeStatus'], []],
  ['来源范围继承属性', ['sources', 0, 'scopes'], ['toString']],
  ['来源错误', ['sources', 0, 'error'], { invalid: true }],
  ['资料格式', ['documents', 0, 'format'], { invalid: true }],
  ['资料语言', ['documents', 0, 'language'], { invalid: true }],
  ['资料类型', ['documents', 0, 'documentType'], { invalid: true }],
  ['资料状态', ['documents', 0, 'status'], { invalid: true }],
  ['资料错误', ['documents', 0, 'error'], { invalid: true }],
  ['资料目录', ['documents', 0, 'folderIds'], [null]],
  ['版本错误', ['documents', 0, 'versions', 0, 'error'], { invalid: true }],
  ['版本大小', ['documents', 0, 'versions', 0, 'size'], -1],
  ['事件种类', ['events', 0, 'kind'], { invalid: true }],
  ['事件摘要', ['events', 0, 'summary'], { invalid: true }],
  ['事件对比', ['events', 0, 'before'], { invalid: true }],
  ['事件对比后文', ['events', 0, 'after'], { invalid: true }],
  ['运行错误', ['runs', 0, 'error'], { invalid: true }],
  ['运行范围详情', ['runs', 0, 'details'], { scopeStatus: { Q: { status: { invalid: true } } } }],
  ['任务错误', ['jobs', 0, 'error'], { invalid: true }],
  ['任务解析选择', ['jobs', 0, 'parse'], 'true'],
  ['逐文件错误', ['jobs', 0, 'items', 0, 'error'], { invalid: true }],
  ['目录名称', ['folders', 0, 'name'], { invalid: true }],
]

test.each(malformed)('损坏的%s不会进入 React，安全恢复演示初始状态', (_name, path, invalid) => {
  const data = createJob(['q1'])
  replaceAt(data, path, invalid)
  window.localStorage.setItem(storageKey, JSON.stringify(data))
  expect(restoreDemo(storageKey)).toEqual(demoSeed())
})

test('存储损坏或不可访问时保留可用界面，存储内容不覆盖当前身份与演示边界', () => {
  window.localStorage.setItem(storageKey, '{broken')
  expect(restoreDemo(storageKey)).toEqual(demoSeed())
  const data = demoSeed()
  data.user = { id: 'untrusted-user', username: 'fake', displayName: '伪造用户' }
  data.canManage = false
  data.integration = { status: 'ready', message: '伪造生产连接', kbUrl: 'https://example.org' }
  data.cost = { modelCalls: 999, message: '伪造账单' }
  persistDemo(storageKey, data)
  const stored = JSON.parse(window.localStorage.getItem(storageKey) || '{}') as InformationSnapshot
  expect(stored.user).toEqual({ id: '', username: '', displayName: '' })
  const restored = restoreDemo(storageKey)
  expect(restored.user).toEqual(demoSeed().user)
  expect(restored.integration).toEqual(demoSeed().integration)
  expect(restored.cost).toEqual(demoSeed().cost)
  expect(restored.canManage).toBe(true)
  vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  expect(restoreDemo(storageKey)).toEqual(demoSeed())
})
