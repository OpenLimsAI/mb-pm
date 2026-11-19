import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import FolderImports from './FolderImports'
import type { FolderImportBootstrap, FolderImportRun, FolderImportTask } from './folder-import-api'

const api = vi.hoisted(() => ({ bootstrap: vi.fn(), save: vi.fn(), probe: vi.fn(), control: vi.fn(), remove: vi.fn(), pair: vi.fn(), runs: vi.fn(), run: vi.fn(), retry: vi.fn(), read: vi.fn() }))
vi.mock('./folder-import-api', () => ({ getFolderImports: api.bootstrap, saveFolderImport: api.save, probeFolderImport: api.probe, controlFolderImport: api.control, deleteFolderImport: api.remove, pairFolderImport: api.pair, getFolderImportRuns: api.runs, getFolderImportRun: api.run, retryFolderImportRun: api.retry, readFolderImportRun: api.read, folderConnectorScriptUrl: '/api/v1/knowledge-sources/v3/folder-imports/connector/script' }))
const folders = [{ id: 'topic', name: '上游工艺开发', writable: true }, { id: 'inbox', name: '待整理', systemRole: 'inbox' as const, writable: true }]
function task(patch: Partial<FolderImportTask> = {}): FolderImportTask {
  return { id: 'task-1', name: '目录任务', kind: 'server', path: 'papers', serverRootId: 'root-1', folderId: 'topic', folderName: '上游工艺开发', sourcePath: '/authorized/papers', includeSubfolders: true, preserveHierarchy: false, schedule: { frequency: 'daily', time: '08:00', timezone: 'Asia/Shanghai', weekday: 0 }, maxFileMb: 100, maxFilesPerScan: 1000, dailyFileLimit: 1000, paused: false, status: 'idle', nextScanAt: '2026-11-18T00:00:00Z', ...patch }
}
function run(patch: Partial<FolderImportRun> = {}): FolderImportRun { return { id: 'run-1', taskId: 'task-1', status: 'processing', phase: 'index', createdAt: '2026-11-17T00:00:00Z', total: 1, processed: 1, completed: 0, failed: 0, new: 1, updated: 0, unchanged: 0, initial: false, ...patch } }
let bootstrap: FolderImportBootstrap
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear()
  bootstrap = { tasks: [], roots: [{ id: 'root-1', name: '研究资料目录' }], canWrite: true, workerEnabled: true, maxFileMb: 100, connectorOnlineSeconds: 90 }
  api.bootstrap.mockImplementation(async () => structuredClone(bootstrap))
  api.probe.mockResolvedValue({ valid: true, fileCount: 10, totalBytes: 12 * 1024 * 1024 })
  api.save.mockImplementation(async config => {
    const saved = task(config.kind === 'local' ? { ...config, sourcePath: config.path || config.localFolderName } : config)
    bootstrap.tasks = [saved]
    return { task: saved }
  })
  api.control.mockResolvedValue({}); api.remove.mockResolvedValue({ deleted: true }); api.pair.mockResolvedValue({ code: 'ONE-TIME-CODE', expiresAt: new Date(Date.now() + 600000).toISOString() })
  api.runs.mockResolvedValue({ runs: [] }); api.run.mockResolvedValue({ run: run(), items: [] }); api.retry.mockResolvedValue({}); api.read.mockResolvedValue({})
})
const mount = (props: Partial<Parameters<typeof FolderImports>[0]> = {}) => render(<FolderImports folders={folders} canManage {...props} />)
const newTask = async () => fireEvent.click(await screen.findByRole('button', { name: '新建自动导入' }))
const editTask = async () => fireEvent.click(await screen.findByRole('button', { name: '自动导入设置 目录任务' }))
function chooseResearchRoot() {
  fireEvent.change(screen.getByRole('textbox', { name: '服务器已连接目录' }), { target: { value: '研究' } })
  fireEvent.click(screen.getByRole('button', { name: '研究资料目录' }))
}
const expand = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

describe('folder-scoped automatic import drawer', () => {
  const original = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype)
  beforeAll(() => {
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '')
        this.querySelector('button')?.focus()
      }
      HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
    }
  })
  afterAll(() => {
    for (const method of ['showModal', 'close']) {
      if (original[method]) Object.defineProperty(HTMLDialogElement.prototype, method, original[method])
      else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    }
  })

  it('opens creation with this folder selected when existing tasks target other folders', async () => {
    bootstrap.tasks = [task({ folderId: 'inbox' })]
    mount({ drawerFolderId: 'topic', onCloseDrawer: vi.fn() })
    const drawer = screen.getByRole('dialog', { name: '自动导入设置' })
    expect(await within(drawer).findByRole('form', { name: '新建自动导入设置' })).toBeInTheDocument()
    expect(within(drawer).queryByText('目录任务')).not.toBeInTheDocument()
    expect(within(drawer).getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('topic')
  })

  it('shows the current task, its schedule and results, then returns focus to the folder entry', async () => {
    bootstrap.tasks = [
      task({ lastResult: { new: 2, updated: 1, completed: 3, failed: 0, unchanged: 4 } }),
      task({ id: 'task-other', folderId: 'inbox', name: '其他文件夹任务' }),
    ]
    function FolderPage() {
      const [open, setOpen] = useState(false)
      return <><button onClick={() => setOpen(true)}>打开自动导入设置</button>{open && <FolderImports folders={folders} canManage drawerFolderId="topic" onCloseDrawer={() => setOpen(false)} />}</>
    }
    render(<FolderPage />)
    const trigger = screen.getByRole('button', { name: '打开自动导入设置' })
    trigger.focus()
    fireEvent.click(trigger)
    const drawer = screen.getByRole('dialog', { name: '自动导入设置' })
    expect(await within(drawer).findByText('/authorized/papers')).toBeInTheDocument()
    expect(within(drawer).getByText('每天 08:00 · 北京时间')).toBeInTheDocument()
    expect(within(drawer).getByText('上次完成 3 份 · 新增 2 · 更新 1 · 失败 0')).toBeInTheDocument()
    expect(within(drawer).queryByText('其他文件夹任务')).not.toBeInTheDocument()
    await editTask()
    expect(within(drawer).getByRole('form', { name: '自动导入设置' })).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: '返回导入任务' }))
    expect(within(drawer).getByText('/authorized/papers')).toBeInTheDocument()
    fireEvent(drawer, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

describe('folder auto import setup', () => {
  it('presents source, destination and schedule together and preserves selections between source types', async () => {
    const view = mount({ initialFolderId: 'topic', openCreate: 1 })
    const form = within(await screen.findByRole('form', { name: '新建自动导入设置' }))
    expect(form.getByRole('radio', { name: '我的电脑' })).toBeChecked()
    expect(form.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('topic')
    expect(form.getByLabelText('扫描时间', { selector: 'input' })).toHaveValue('08:00')
    expect(form.queryByRole('button', { name: /^(上一步|下一步)$/ })).not.toBeInTheDocument()
    expect(form.queryByRole('option', { name: '默认文件夹' })).not.toBeInTheDocument()
    fireEvent.change(form.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'inbox' } })
    fireEvent.change(form.getByLabelText('扫描时间', { selector: 'input' }), { target: { value: '19:15' } })
    fireEvent.click(form.getByRole('radio', { name: '服务器 / NAS' }))
    expect(form.getByRole('textbox', { name: '服务器子目录' })).toBeVisible()
    expect(form.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('inbox')
    expect(form.getByLabelText('扫描时间', { selector: 'input' })).toHaveValue('19:15')
    view.unmount(); mount({ openCreate: 2 })
    expect(await screen.findByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('')
  })
  it('blocks saving to a missing target until a writable destination is selected', async () => {
    const view = mount({ initialFolderId: 'deleted', openCreate: 1 })
    fireEvent.click(await screen.findByRole('radio', { name: '服务器 / NAS' }))
    chooseResearchRoot()
    expect(screen.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('deleted')
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'topic' } })
    expect(screen.getByRole('button', { name: '开始导入' })).toBeEnabled()
    view.unmount(); mount({ canManage: false })
    await screen.findByText('当前账号不能配置自动导入，可在资料库查看有权访问的资料。')
    expect(screen.queryByRole('button', { name: '新建自动导入' })).not.toBeInTheDocument()
  })
  it('automatically checks a server directory before saving without an extra required check action', async () => {
    mount({ initialFolderId: 'topic' }); await newTask()
    fireEvent.click(screen.getByRole('radio', { name: '服务器 / NAS' }))
    chooseResearchRoot()
    fireEvent.change(screen.getByRole('textbox', { name: '服务器子目录' }), { target: { value: 'papers' } })
    fireEvent.blur(screen.getByRole('textbox', { name: '服务器子目录' }))
    expect(screen.getByRole('textbox', { name: '服务器已连接目录' })).toHaveValue('研究资料目录')
    const destination = screen.getByRole('combobox', { name: '自动导入目标文件夹' })
    expect(destination).toHaveValue('')
    fireEvent.change(destination, { target: { value: 'topic' } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'server', path: 'papers', serverRootId: 'root-1', folderId: 'topic', maxFilesPerScan: 1000, maxFileMb: 100, includeSubfolders: true }), undefined))
    expect(api.probe).toHaveBeenCalledTimes(1)
    expect(api.probe.mock.invocationCallOrder[0]).toBeLessThan(api.save.mock.invocationCallOrder[0])
    expect(await screen.findByText('自动导入设置已保存。')).toBeInTheDocument()
  })
  it('keeps the source, destination and schedule visible when the automatic directory check fails', async () => {
    api.probe.mockResolvedValue({ valid: false, fileCount: null, totalBytes: null, message: '目录不在授权范围内。' })
    mount(); await newTask(); fireEvent.click(screen.getByRole('radio', { name: '服务器 / NAS' }))
    chooseResearchRoot()
    fireEvent.change(screen.getByRole('textbox', { name: '服务器子目录' }), { target: { value: 'private' } })
    fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'topic' } })
    fireEvent.change(screen.getByLabelText('扫描时间', { selector: 'input' }), { target: { value: '21:30' } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('目录不在授权范围内')
    expect(screen.getByRole('textbox', { name: '服务器子目录' })).toHaveValue('private')
    expect(api.save).not.toHaveBeenCalled()
    api.probe.mockResolvedValue({ valid: true, fileCount: 10, totalBytes: 12000 })
    fireEvent.change(screen.getByRole('textbox', { name: '服务器子目录' }), { target: { value: 'papers' } })
    expect(screen.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('topic')
    expect(screen.getByLabelText('扫描时间', { selector: 'input' })).toHaveValue('21:30')
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ path: 'papers', folderId: 'topic', schedule: expect.objectContaining({ time: '21:30' }) }), undefined))
  })
  it('saves weekly dates and timezone without showing advanced fields until requested', async () => {
    mount(); await newTask()
    fireEvent.click(screen.getByRole('radio', { name: '服务器 / NAS' }))
    chooseResearchRoot()
    fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'inbox' } })
    fireEvent.click(screen.getByRole('radio', { name: '每周' }))
    fireEvent.change(screen.getByRole('combobox', { name: '每周扫描日期' }), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText('扫描时间', { selector: 'input' }), { target: { value: '21:30' } })
    fireEvent.click(screen.getByText('北京时间', { exact: true, selector: 'summary' }))
    fireEvent.change(screen.getByRole('combobox', { name: '扫描时区' }), { target: { value: 'UTC' } })
    expect(screen.getByText('更多选项').closest('details')).not.toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'server', folderId: 'inbox', schedule: { frequency: 'weekly', weekday: 6, time: '21:30', timezone: 'UTC' } }), undefined))
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })
  it('uses the chosen directory in the inline connection and keeps the saved task on the same page', async () => {
    const choose = vi.fn().mockResolvedValue({ kind: 'directory', name: 'Papers' })
    vi.stubGlobal('showDirectoryPicker', choose)
    try {
      mount(); await newTask()
      const form = screen.getByRole('form', { name: '新建自动导入设置' })
      const save = within(form).getByRole('button', { name: '保存并连接电脑' })
      expect(save).toBeDisabled()
      fireEvent.click(within(form).getByRole('button', { name: '选择电脑文件夹' }))
      await waitFor(() => expect(within(form).getByText('Papers')).toBeVisible())
      expect(save).toBeDisabled()
      expect(choose).toHaveBeenCalledWith(expect.objectContaining({ mode: 'read' }))
      fireEvent.change(within(form).getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'topic' } })
      fireEvent.click(save)
      const panel = await screen.findByRole('region', { name: '连接我的电脑' })
      expect(await within(panel).findByText('ONE-TIME-CODE')).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('topic')
      expect(screen.getByLabelText('扫描时间', { selector: 'input' })).toHaveValue('08:00')
      expect(within(panel).getByRole('link', { name: '下载电脑连接程序' })).toHaveAttribute('href', '/api/v1/knowledge-sources/v3/folder-imports/connector/script')
      expect(within(panel).getByRole('button', { name: '复制连接命令' })).toBeInTheDocument()
      fireEvent.click(within(panel).getByText('查看运行命令'))
      const command = within(panel).getByText(/--server/)
      expect(command).toHaveTextContent('--folder .')
      expect(command).toHaveTextContent('--expected-folder-name=Papers')
      expect(command).toHaveTextContent('folder-task-1.json')
      expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'local', path: '', localFolderName: 'Papers', folderId: 'topic' }), undefined)
      expect(within(form).queryByRole('button', { name: '保存并连接电脑' })).not.toBeInTheDocument()
      fireEvent.submit(form)
      expect(api.save).toHaveBeenCalledTimes(1)
      expect(api.pair).toHaveBeenCalledTimes(1)
      expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('keeps selections after canceling the directory picker and pairs using an explicitly entered full path', async () => {
    const choose = vi.fn().mockRejectedValue(new DOMException('Canceled', 'AbortError'))
    vi.stubGlobal('showDirectoryPicker', choose)
    try {
      mount(); await newTask()
      const save = screen.getByRole('button', { name: '保存并连接电脑' })
      fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'topic' } })
      fireEvent.click(screen.getByRole('button', { name: '选择电脑文件夹' }))
      await waitFor(() => expect(choose).toHaveBeenCalledTimes(1))
      expect(save).toBeDisabled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('topic')
      fireEvent.click(screen.getByRole('button', { name: '输入完整路径' }))
      fireEvent.change(screen.getByRole('textbox', { name: '本机文件夹完整路径' }), { target: { value: '/Users/example/My Papers' } })
      fireEvent.click(save)
      const panel = await screen.findByRole('region', { name: '连接我的电脑' })
      expect(await within(panel).findByText('ONE-TIME-CODE')).toBeInTheDocument()
      fireEvent.click(within(panel).getByText('查看运行命令'))
      expect(within(panel).getByText(/--server/)).toHaveTextContent("--folder '/Users/example/My Papers'")
      expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'local', path: '/Users/example/My Papers', folderId: 'topic' }), undefined)
      expect(api.save).toHaveBeenCalledTimes(1)
      expect(api.pair).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('keeps manual-only scans available without displaying a misleading scheduled time', async () => {
    mount(); await newTask()
    fireEvent.click(screen.getByRole('radio', { name: '服务器 / NAS' }))
    chooseResearchRoot()
    fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'inbox' } })
    fireEvent.click(screen.getByRole('radio', { name: '仅手动' }))
    expect(screen.queryByLabelText('扫描时间', { selector: 'input' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ schedule: expect.objectContaining({ frequency: 'manual' }) }), undefined))
    expect(await screen.findByText('仅手动扫描')).toBeInTheDocument()
    expect(screen.queryByText(/下次扫描/)).not.toBeInTheDocument()
  })
  it('saves a daily allowance independently from the per-scan limit', async () => {
    mount(); await newTask()
    fireEvent.click(screen.getByRole('radio', { name: '服务器 / NAS' }))
    chooseResearchRoot()
    fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'inbox' } })
    fireEvent.click(screen.getByText('更多选项'))
    const input = screen.getByRole('spinbutton', { name: '每日处理上限' })
    expect(input).toHaveValue(1000); expect(input).toHaveAttribute('min', '1'); expect(input).toHaveAttribute('max', '50000')
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ dailyFileLimit: 7, maxFilesPerScan: 1000 }), undefined))
  })
  it('opens existing settings as three summaries, replaces the task list, and expands only one section', async () => {
    bootstrap.tasks = [task()]
    mount(); await editTask()
    expect(screen.getByRole('heading', { name: '目录任务', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '目录任务' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建自动导入' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更改扫描文件夹' })).toHaveTextContent('研究资料目录 / papers')
    expect(screen.getByRole('button', { name: '更改保存位置' })).toHaveTextContent('上游工艺开发')
    expect(screen.getByRole('button', { name: '更改扫描时间' })).toHaveTextContent('每天 08:00 · 北京时间')
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled()
    expand('更改扫描文件夹')
    expect(screen.getByRole('textbox', { name: '服务器已连接目录' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '我的电脑' })).not.toBeInTheDocument()
    expand('更改保存位置')
    expect(screen.queryByRole('textbox', { name: '服务器已连接目录' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '自动导入目标文件夹' })).toBeInTheDocument()
    expand('更改扫描时间')
    expect(screen.queryByRole('combobox', { name: '自动导入目标文件夹' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('扫描时间', { selector: 'input' })).toHaveValue('08:00')
    fireEvent.click(screen.getByRole('button', { name: '返回自动导入' }))
    expect(screen.getByRole('button', { name: '目录任务' })).toBeInTheDocument()
  })
  it('reuses a source check when the destination or schedule changes and preserves existing advanced limits', async () => {
    bootstrap.tasks = [task({ dailyFileLimit: 13, maxFilesPerScan: 20, maxFileMb: 50, preserveHierarchy: true })]
    mount(); await editTask(); expand('更改扫描文件夹')
    fireEvent.click(screen.getByRole('button', { name: '检查目录' })); await screen.findByText('发现 10 份 PDF')
    expand('更改保存位置')
    fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'inbox' } })
    expand('更改扫描时间')
    fireEvent.change(screen.getByLabelText('扫描时间', { selector: 'input' }), { target: { value: '10:15' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'inbox', dailyFileLimit: 13, maxFilesPerScan: 20, maxFileMb: 50, preserveHierarchy: true, schedule: expect.objectContaining({ time: '10:15' }) }), 'task-1'))
    expect(api.probe).toHaveBeenCalledTimes(1)
  })
  it('rechecks after the actual source changes and does not save when the new directory fails', async () => {
    bootstrap.tasks = [task()]
    mount(); await editTask(); expand('更改扫描文件夹')
    fireEvent.click(screen.getByRole('button', { name: '检查目录' })); await screen.findByText('发现 10 份 PDF')
    fireEvent.change(screen.getByRole('textbox', { name: '服务器子目录' }), { target: { value: 'another' } })
    expect(screen.queryByText('发现 10 份 PDF')).not.toBeInTheDocument()
    api.probe.mockRejectedValueOnce(new Error('source unavailable'))
    expand('更改扫描时间'); fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '服务器子目录' })).toHaveValue('another')
    expect(api.probe).toHaveBeenCalledTimes(2); expect(api.save).not.toHaveBeenCalled()
  })
  it('keeps missing targets explicit and prevents losing edited settings when connecting a computer', async () => {
    bootstrap.tasks = [task({ kind: 'local', path: '/Users/example/Papers', sourcePath: '/Users/example/Papers', folderId: 'gone', connectorOnline: false })]
    mount(); await editTask()
    expect(screen.getByRole('button', { name: '更改保存位置' })).toHaveTextContent('请选择可用的文件夹')
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled()
    expand('更改保存位置')
    expect(screen.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('gone')
    fireEvent.change(screen.getByRole('combobox', { name: '自动导入目标文件夹' }), { target: { value: 'topic' } })
    expand('更改扫描文件夹')
    expect(screen.getByRole('button', { name: '连接电脑' })).toBeDisabled()
    expect(screen.getByText('请先保存修改，再连接电脑。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '服务器子目录' })).not.toBeInTheDocument()
    expect(api.pair).not.toHaveBeenCalled()
  })
})

describe('folder auto import operations', () => {
  it('names task actions explicitly and separates the source folder from its knowledge destination', async () => {
    bootstrap.tasks = [task()]
    const openFolder = vi.fn()
    mount({ onOpenFolder: openFolder })
    const settings = await screen.findByRole('button', { name: '自动导入设置 目录任务' })
    expect(settings).toHaveTextContent('自动导入设置')
    expect(settings.querySelector('svg')).toBeNull()
    expect(screen.getByRole('button', { name: '暂停 目录任务' })).toHaveTextContent('暂停')
    const route = screen.getByLabelText('目录任务文件夹流向')
    expect(route).toHaveTextContent('扫描来源 · 服务器 / NAS')
    expect(route).toHaveTextContent('/authorized/papers')
    expect(route).toHaveTextContent('保存到知识库')
    fireEvent.click(within(route).getByRole('button', { name: '上游工艺开发' }))
    expect(openFolder).toHaveBeenCalledWith('topic')
    expect(screen.getByText('每天 08:00 · 北京时间')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '运行记录 目录任务' }))
    expect(await screen.findByRole('heading', { name: '运行记录' })).toBeInTheDocument()
  })
  it('shows offline as waiting and makes the scan request persistent without claiming a successful scan', async () => {
    bootstrap.tasks = [task({ kind: 'local', connectorOnline: false, status: 'offline' })]
    mount(); await screen.findByText('等待电脑连接')
    fireEvent.click(screen.getByRole('button', { name: '立即扫描' }))
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('task-1', 'scan'))
    expect(await screen.findByText(/连接电脑后会开始首次导入/)).toBeInTheDocument()
    expect(screen.queryByText('已完成')).not.toBeInTheDocument()
  })
  it('pauses and resumes using server state, and retains loaded tasks when refreshing fails', async () => {
    bootstrap.tasks = [task()]
    api.control.mockImplementation(async (_id, action) => { bootstrap.tasks[0].paused = action === 'pause'; return { task: bootstrap.tasks[0] } })
    mount(); fireEvent.click(await screen.findByRole('button', { name: '暂停 目录任务' }))
    expect(await screen.findByRole('button', { name: '恢复 目录任务' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复 目录任务' }))
    expect(await screen.findByRole('button', { name: '暂停 目录任务' })).toBeInTheDocument()
    api.bootstrap.mockRejectedValueOnce(new Error('network'))
    fireEvent.click(screen.getByRole('button', { name: '暂停 目录任务' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '目录任务' })).toBeInTheDocument()
  })
  it('opens an existing run without enqueueing a duplicate scan and keeps indexing distinct from completion', async () => {
    bootstrap.tasks = [task({ status: 'processing' })]
    api.runs.mockResolvedValue({ runs: [run()] })
    api.run.mockResolvedValue({ run: run(), items: [{ id: 'item-1', relativePath: 'study.pdf', size: 12000, status: 'processing', phase: 'index', originalSaved: true, indexStatus: 'pending', change: 'new' }] })
    mount(); fireEvent.click(await screen.findByRole('button', { name: '查看进度' }))
    expect(await screen.findByText('正在建立问答索引')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '文件处理进度' })).toHaveAttribute('value', '1')
    expect(screen.getByText('已检查 1 / 1 · 完成 0 · 失败 0')).toBeInTheDocument()
    expect(screen.queryByText('可问答')).not.toBeInTheDocument(); expect(api.control).not.toHaveBeenCalled()
  })
  it('offers only failed-stage retries for a single file or the failed batch, preserving saved-original evidence', async () => {
    bootstrap.tasks = [task({ status: 'needs_attention' })]
    const result = run({ status: 'partial', phase: 'done', failed: 1 })
    api.runs.mockResolvedValue({ runs: [result] })
    api.run.mockResolvedValue({ run: result, items: [{ id: 'failed-item', relativePath: 'retry.pdf', size: 12000, status: 'failed', phase: 'index', originalSaved: true, indexStatus: 'failed', change: 'new', error: '索引服务暂不可用。' }] })
    mount(); fireEvent.click(await screen.findByRole('button', { name: '目录任务' }))
    expect(await screen.findByText('建立问答索引失败')).toBeInTheDocument()
    expect(screen.getByText('12 KB · 原件已保存')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试 retry.pdf' }))
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith('run-1', ['failed-item']))
    await waitFor(() => expect(screen.getByRole('button', { name: '重试本次失败项' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '重试本次失败项' }))
    await waitFor(() => expect(api.retry).toHaveBeenLastCalledWith('run-1', undefined))
  })
  it('deletes a paused task from its own card only after confirmation', async () => {
    bootstrap.tasks = [task(), task({ id: 'paused', name: 'USP_EP', paused: true })]
    api.remove.mockImplementationOnce(async id => { bootstrap.tasks = bootstrap.tasks.filter(item => item.id !== id); return { deleted: true } })
    mount()
    const trigger = await screen.findByRole('button', { name: '删除任务 USP_EP' })
    const card = trigger.closest('article')!
    fireEvent.click(trigger)
    const confirmation = within(card).getByRole('group', { name: '删除自动导入任务' })
    expect(confirmation).toHaveTextContent('删除「USP_EP」？')
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }))
    expect(within(card).queryByRole('group', { name: '删除自动导入任务' })).not.toBeInTheDocument()
    expect(api.remove).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.click(within(card).getByRole('button', { name: '删除自动导入任务' }))
    await waitFor(() => expect(trigger).not.toBeInTheDocument())
    expect(api.remove).toHaveBeenCalledExactlyOnceWith('paused')
    expect(screen.getByRole('button', { name: '删除任务 目录任务' })).toBeInTheDocument()
    expect(api.control).not.toHaveBeenCalled()
  })
  it('hides the task deletion action for read-only users', async () => {
    bootstrap.tasks = [task()]
    bootstrap.canWrite = false
    mount()
    await screen.findByRole('button', { name: '目录任务' })
    expect(screen.queryByRole('button', { name: /删除任务/ })).not.toBeInTheDocument()
  })
  it('replaces settings with a clear delete confirmation that preserves documents', async () => {
    bootstrap.tasks = [task()]
    mount(); fireEvent.click(await screen.findByRole('button', { name: '自动导入设置 目录任务' }))
    expect(screen.getByRole('form', { name: '自动导入设置' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('任务管理'))
    fireEvent.click(screen.getByRole('button', { name: '删除此自动导入任务' }))
    expect(screen.queryByRole('form', { name: '自动导入设置' })).not.toBeInTheDocument()
    const confirmation = screen.getByRole('group', { name: '删除自动导入任务' })
    expect(confirmation).toHaveTextContent('源文件和已导入的知识库资料都会保留')
    expect(api.remove).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '删除自动导入任务' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledExactlyOnceWith('task-1'))
    expect(await screen.findByText('自动导入任务已删除，知识库资料保留。')).toBeInTheDocument()
  })
  it('refreshes library results when a later run completes fewer files than the first batch', async () => {
    bootstrap.tasks = [task()]
    api.runs.mockResolvedValue({ runs: [run({ id: 'first', status: 'completed', completed: 10 }), run({ id: 'second', status: 'completed', completed: 1 })] })
    api.run.mockImplementation(async id => ({ run: run({ id, status: 'completed', completed: id === 'first' ? 10 : 1 }), items: [] }))
    const imported = vi.fn(); mount({ onImported: imported })
    fireEvent.click(await screen.findByRole('button', { name: '目录任务' }))
    await waitFor(() => expect(imported).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('combobox', { name: '选择扫描记录' }), { target: { value: 'second' } })
    await waitFor(() => expect(imported).toHaveBeenCalledTimes(2))
  })
  it('keeps a quota-waiting run visible and does not create another scan', async () => {
    bootstrap.tasks = [task({ status: 'waiting_quota', nextRetryAt: '2026-11-17T16:00:00Z', lastError: '今日额度已用完，次日继续', usage: { date: '2026-11-17', timezone: 'Asia/Shanghai', completedFiles: 2, limit: 2, remainingFiles: 0, originalBytes: 1200000, parsedPages: 3, parsedCharacters: 1000, indexedFiles: 2, reusedFiles: 0 } })]
    const waiting = run({ status: 'waiting_quota', total: 10, completed: 2, processed: 2 })
    api.runs.mockResolvedValue({ runs: [waiting] }); api.run.mockResolvedValue({ run: waiting, items: [] })
    mount(); expect(await screen.findByText('等待明日额度')).toBeInTheDocument()
    expect(screen.getByText(/今日已处理 2 \/ 2 份/)).toHaveTextContent('11/18 00:00 继续当前任务')
    fireEvent.click(screen.getByRole('button', { name: '查看进度' }))
    expect(await screen.findByText('已检查 2 / 10 · 完成 2 · 失败 0')).toBeInTheDocument()
    expect(api.control).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '重试本次失败项' })).not.toBeInTheDocument()
  })
})
