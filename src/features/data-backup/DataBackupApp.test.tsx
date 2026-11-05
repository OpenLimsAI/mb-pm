import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DataBackupApp, { BackupWorkspace } from './DataBackupApp'
import { backupApi, BackupApiError, previewSnapshot, type BackupSnapshot, type DeletePreview } from './api'

const context = vi.hoisted(() => ({ current: { user: { id: 'admin-a', username: 'admin-a', displayName: '管理员甲' }, identityNamespace: 'namespace-a', applications: [{ id: 'data-backup', enabled: true }], preview: false, logout: () => {} } }))
vi.mock('../../components/portal/context', () => ({ usePortalContext: () => context.current }))
function snapshot(): BackupSnapshot {
  return { ...structuredClone(previewSnapshot), connected: true, generatedAt: '2026-11-04T12:00:00Z', catalogRevision: 'a'.repeat(64),
    plan: { status: 'active', source: 'cron', timezone: 'Asia/Shanghai', summary: '每日 02:17 执行完整业务备份。', retentionSummary: '保留最近 11 份完整业务备份。', checkedAt: '2026-11-04T12:00:00Z' },
    storage: { totalBytes: 200 * 1024 ** 3, freeBytes: 90 * 1024 ** 3, backupBytes: 3 * 1024 ** 3, archiveBytes: 2 * 1024 ** 3, otherBytes: 1024 ** 3 },
    roots: [{ id: 'business', label: '完整业务备份', archiveCount: 3, sizeBytes: 1024 ** 3, diskBytes: 2 * 1024 ** 3, otherBytes: 1024 ** 3 }],
    archives: [
      { id: '1'.repeat(64), name: 'business-latest.tar.gz.gpg', rootLabel: '完整业务备份', sizeBytes: 1024, diskBytes: 4096, createdAt: '2026-11-04T03:00:00Z', verifiedAt: '2026-11-04T03:04:00Z', status: 'verified', contents: [{ name: '项目管理', kind: 'database', detail: '包含任务和成员数据。' }], protected: true, protectionReason: '最近一份已验证备份，不能删除。' },
      { id: '2'.repeat(64), name: 'business-old-a.tar.gz.gpg', rootLabel: '完整业务备份', sizeBytes: 2048, diskBytes: 4096, createdAt: '2026-11-03T03:00:00Z', verifiedAt: null, status: 'unknown', contents: [], protected: false, protectionReason: null },
      { id: '3'.repeat(64), name: 'business-old-b.tar.gz.gpg', rootLabel: '完整业务备份', sizeBytes: 3072, diskBytes: 4096, createdAt: '2026-11-02T03:00:00Z', verifiedAt: null, status: 'unknown', contents: [], protected: false, protectionReason: null },
    ],
  }
}
function deletionPreview(ids = ['2'.repeat(64)]): DeletePreview {
  const items = snapshot().archives.filter(item => ids.includes(item.id))
  return { token: 'opaque-deletion-token', itemCount: items.length, items, sizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0), diskBytes: items.reduce((sum, item) => sum + item.diskBytes, 0), expiresAt: new Date(Date.now() + 300_000).toISOString() }
}
const show = (props: Partial<Parameters<typeof BackupWorkspace>[0]> = {}) => render(<MemoryRouter><BackupWorkspace identity="admin-a" allowed preview={false} {...props} /></MemoryRouter>)
const ready = () => screen.findByText('business-old-a.tar.gz.gpg')
async function singleDialog() {
  fireEvent.click(screen.getByRole('button', { name: '删除 business-old-a.tar.gz.gpg' }))
  return screen.findByRole('dialog')
}
beforeEach(() => {
  context.current.user = { id: 'admin-a', username: 'admin-a', displayName: '管理员甲' }; context.current.identityNamespace = 'namespace-a'
  vi.spyOn(backupApi, 'snapshot').mockResolvedValue(snapshot())
  vi.spyOn(backupApi, 'previewDeletion').mockImplementation(async (_, ids) => deletionPreview(ids))
  vi.spyOn(backupApi, 'deleteArchives').mockResolvedValue({ id: 'delete-1', actor: 'admin-a', createdAt: '2026-11-04T12:00:00Z', status: 'succeeded', deletedCount: 1, deletedBytes: 2048 })
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('shows unmistakable fictional preview without calling API or offering writes', () => {
  show({ preview: true, allowed: false })
  expect(screen.getByText(/下方文件均为虚构示例/)).toBeVisible()
  expect(screen.getByText('预览未读取服务器的实际备份计划。')).toBeVisible()
  expect(screen.getByText('示例 · 完整业务备份 A')).toBeVisible()
  expect(screen.getByRole('button', { name: '删除所选' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '删除 示例 · 完整业务备份 B' })).toBeDisabled()
  expect(backupApi.snapshot).not.toHaveBeenCalled(); expect(backupApi.previewDeletion).not.toHaveBeenCalled(); expect(backupApi.deleteArchives).not.toHaveBeenCalled()
})
it('requires the data-backup entitlement and does not infer access from other administration rights', () => {
  show({ allowed: false })
  expect(screen.getByRole('heading', { name: '仅系统管理员可管理数据备份' })).toBeVisible()
  expect(backupApi.snapshot).not.toHaveBeenCalled()
})
it('shows actual cron plan and distinguishes logical sizes, allocated archive space and other materials', async () => {
  show(); await ready()
  expect(screen.getByText('每日 02:17 执行完整业务备份。')).toBeVisible()
  expect(screen.getByText('保留最近 11 份完整业务备份。')).toBeVisible()
  expect(screen.getByText('备份归档 2.0 GiB · 其他备份材料 1.0 GiB')).toBeVisible()
  expect(screen.getByText('90.0 GiB')).toBeVisible()
  expect(screen.getByText('2.0 KiB')).toBeVisible()
  expect(screen.getAllByText('占磁盘 4.0 KiB')).toHaveLength(3)
  const row = screen.getByText('business-latest.tar.gz.gpg').closest('tr')!
  fireEvent.click(within(row).getByText('查看备份内容（1 项）'))
  expect(within(row).getByText('包含任务和成员数据。')).toBeVisible()
  for (const label of ['立即备份', '保存计划', '校验', '恢复演练', '清理过期备份']) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
})
it('never invents schedule or retention defaults when actual plan is unknown', async () => {
  const data = snapshot(); data.plan = { status: 'unknown', source: 'cron', timezone: '', summary: '', retentionSummary: '', checkedAt: '' }
  vi.mocked(backupApi.snapshot).mockResolvedValue(data)
  show(); await ready()
  expect(screen.getByText('未获取到可确认的计划，请检查服务器配置。')).toBeVisible()
  expect(screen.getByText('保留规则尚未确认。')).toBeVisible()
  expect(screen.queryByText(/03:30|14 天|14 份/)).not.toBeInTheDocument()
})
it('protects the last verified backup without disabling other rows, and select-all excludes it', async () => {
  show(); await ready()
  expect(screen.getByRole('checkbox', { name: '选择 business-latest.tar.gz.gpg' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '删除 business-latest.tar.gz.gpg' })).toBeDisabled()
  expect(screen.getByText('最近一份已验证备份，不能删除。')).toBeVisible()
  fireEvent.click(screen.getByRole('checkbox', { name: '选择所有可删除备份' }))
  expect(screen.getByRole('checkbox', { name: '选择 business-old-a.tar.gz.gpg' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: '选择 business-old-b.tar.gz.gpg' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: '选择 business-latest.tar.gz.gpg' })).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '删除所选（2）' }))
  const dialog = await screen.findByRole('dialog')
  expect(backupApi.previewDeletion).toHaveBeenCalledWith('admin-a', ['2'.repeat(64), '3'.repeat(64)], 'a'.repeat(64), expect.any(AbortSignal))
  expect(within(dialog).getByText('business-old-a.tar.gz.gpg')).toBeVisible()
  expect(within(dialog).getByText('business-old-b.tar.gz.gpg')).toBeVisible()
  expect(within(dialog).getByText('共 2 份备份')).toBeVisible()
  expect(within(dialog).getByText('文件大小：5.0 KiB（5,120 字节）')).toBeVisible()
  expect(within(dialog).getByText('磁盘占用：8.0 KiB（8,192 字节）')).toBeVisible()
  expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeDisabled()
  fireEvent.change(within(dialog).getByLabelText('删除确认文字'), { target: { value: '删除 1 份备份' } })
  expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeDisabled()
  fireEvent.change(within(dialog).getByLabelText('删除确认文字'), { target: { value: '删除 2 份备份' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(backupApi.deleteArchives).toHaveBeenCalledTimes(1))
  expect(vi.mocked(backupApi.deleteArchives).mock.calls[0][1]).toEqual({ token: 'opaque-deletion-token', confirmation: '删除 2 份备份', requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) })
})
it('reuses idempotency ID after transport failure and shows the actual partial deletion result', async () => {
  vi.mocked(backupApi.deleteArchives).mockRejectedValueOnce(new BackupApiError(503, '连接中断，请重试。')).mockResolvedValueOnce({ id: 'partial', actor: 'admin-a', createdAt: '', status: 'partial', deletedCount: 0, deletedBytes: 0, error: '文件已被其他任务占用。' })
  show(); await ready(); const dialog = await singleDialog()
  fireEvent.change(within(dialog).getByLabelText('删除确认文字'), { target: { value: '删除 1 份备份' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '确认删除' })).not.toBeDisabled())
  expect(within(dialog).getByRole('alert')).toHaveTextContent('连接中断')
  fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(backupApi.deleteArchives).toHaveBeenCalledTimes(2))
  const calls = vi.mocked(backupApi.deleteArchives).mock.calls
  expect(calls[1][1].requestId).toBe(calls[0][1].requestId)
  expect(await screen.findByText('部分完成：文件已被其他任务占用。')).toBeVisible()
})
it.each([401, 403, 409])('clears loaded data and cancels confirmation on access/identity failure %s', async status => {
  show(); await ready(); await singleDialog()
  vi.mocked(backupApi.snapshot).mockRejectedValueOnce(new BackupApiError(status, '访问已变化', status === 409 ? 'backup_identity_changed' : ''))
  fireEvent.click(screen.getByRole('button', { name: '关闭确认窗口' }))
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  await screen.findByRole('heading', { name: '仅系统管理员可管理数据备份' })
  expect(screen.queryByText('business-old-a.tar.gz.gpg')).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('aborts and ignores late account responses when the portal identity changes', async () => {
  let resolve!: (value: BackupSnapshot) => void
  vi.mocked(backupApi.snapshot).mockReturnValueOnce(new Promise(done => { resolve = done }))
  const view = render(<MemoryRouter><DataBackupApp /></MemoryRouter>)
  await act(async () => {})
  const signal = vi.mocked(backupApi.snapshot).mock.calls[0][1]
  context.current.user = { id: 'admin-b', username: 'admin-b', displayName: '管理员乙' }; context.current.identityNamespace = 'namespace-b'
  const next = snapshot(); next.archives = []
  vi.mocked(backupApi.snapshot).mockResolvedValue(next)
  view.rerender(<MemoryRouter><DataBackupApp /></MemoryRouter>)
  await act(async () => resolve(snapshot()))
  expect(signal.aborted).toBe(true)
  expect(screen.queryByText('business-old-a.tar.gz.gpg')).not.toBeInTheDocument()
  expect(backupApi.snapshot).toHaveBeenLastCalledWith('admin-b', expect.any(AbortSignal))
})
it('invalidates selection and open delete confirmation when polling discovers a new catalog revision', async () => {
  vi.useFakeTimers(); show(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '删除 business-old-a.tar.gz.gpg' })); await act(async () => {})
  expect(screen.getByRole('dialog')).toBeVisible()
  const next = snapshot(); next.catalogRevision = 'b'.repeat(64)
  vi.mocked(backupApi.snapshot).mockResolvedValue(next)
  await act(async () => { vi.advanceTimersByTime(30_000) })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: '选择 business-old-a.tar.gz.gpg' })).not.toBeChecked()
  expect(screen.getByText('备份目录已更新，请重新选择文件并确认删除清单。')).toBeVisible()
  expect(backupApi.deleteArchives).not.toHaveBeenCalled()
})
it('ignores a delayed deletion preview if the catalog changed while it was loading', async () => {
  vi.useFakeTimers()
  let resolve!: (value: DeletePreview) => void
  vi.mocked(backupApi.previewDeletion).mockReturnValueOnce(new Promise(done => { resolve = done }))
  show(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '删除 business-old-a.tar.gz.gpg' }))
  const next = snapshot(); next.catalogRevision = 'b'.repeat(64)
  vi.mocked(backupApi.snapshot).mockResolvedValue(next)
  await act(async () => { vi.advanceTimersByTime(30_000) })
  await act(async () => resolve(deletionPreview()))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(backupApi.deleteArchives).not.toHaveBeenCalled()
})
it('expires confirmation after five minutes and requires a new preview', async () => {
  vi.useFakeTimers(); show(); await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '删除 business-old-a.tar.gz.gpg' })); await act(async () => {})
  const dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('删除确认文字'), { target: { value: '删除 1 份备份' } })
  await act(async () => { vi.advanceTimersByTime(300_001) })
  expect(within(dialog).getByText('删除预览已过期，请重新核对清单后确认。')).toBeVisible()
  expect(within(dialog).queryByRole('button', { name: '确认删除' })).not.toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: '重新核对清单' })); await act(async () => {})
  expect(backupApi.previewDeletion).toHaveBeenCalledTimes(2)
  expect(screen.getByLabelText('删除确认文字')).toHaveValue('')
  expect(backupApi.deleteArchives).not.toHaveBeenCalled()
})
it('refreshes pending metadata every five seconds, normal catalogs every thirty, and pauses while hidden', async () => {
  vi.useFakeTimers()
  const data = snapshot(); data.archives[0].status = 'pending'
  vi.mocked(backupApi.snapshot).mockResolvedValue(data)
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const view = show(); await act(async () => {})
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(backupApi.snapshot).toHaveBeenCalledTimes(2)
  visible.mockReturnValue('hidden')
  await act(async () => { vi.advanceTimersByTime(15000) })
  expect(backupApi.snapshot).toHaveBeenCalledTimes(2)
  visible.mockReturnValue('visible'); vi.mocked(backupApi.snapshot).mockResolvedValue(snapshot())
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(backupApi.snapshot).toHaveBeenCalledTimes(3)
  await act(async () => { vi.advanceTimersByTime(29_999) })
  expect(backupApi.snapshot).toHaveBeenCalledTimes(3)
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(backupApi.snapshot).toHaveBeenCalledTimes(4)
  const signal = vi.mocked(backupApi.snapshot).mock.calls[0][1]
  view.unmount(); expect(signal.aborted).toBe(true)
})
it('rejects stale deletion on the server with its specific reason and closes the invalid confirmation', async () => {
  vi.mocked(backupApi.deleteArchives).mockRejectedValueOnce(new BackupApiError(409, '目录已发生变化。', 'revision_conflict'))
  show(); await ready(); const dialog = await singleDialog()
  fireEvent.change(within(dialog).getByLabelText('删除确认文字'), { target: { value: '删除 1 份备份' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByText('目录已发生变化。 请重新选择备份。')).toBeVisible()
})
it('limits one deletion selection to the server limit of one hundred archives', async () => {
  const data = snapshot()
  data.archives = Array.from({ length: 101 }, (_, index) => ({ ...data.archives[1], id: index.toString(16).padStart(64, '0'), name: `old-${index}.gpg` }))
  vi.mocked(backupApi.snapshot).mockResolvedValue(data)
  show(); await screen.findByText('old-100.gpg')
  fireEvent.click(screen.getByRole('checkbox', { name: '选择前 100 份可删除备份' }))
  expect(screen.getByRole('button', { name: '删除所选（100）' })).toBeEnabled()
  expect(screen.getByRole('checkbox', { name: '选择 old-100.gpg' })).not.toBeChecked()
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 old-100.gpg' }))
  expect(screen.getByRole('checkbox', { name: '选择 old-100.gpg' })).not.toBeChecked()
  expect(screen.getByText('每次最多选择 100 份备份，请分批操作。')).toBeVisible()
})
