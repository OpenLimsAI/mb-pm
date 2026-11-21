import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FolderImportConnection from './FolderImportConnection'
import type { FolderImportTask } from './folder-import-api'

vi.mock('./folder-import-api', () => ({ folderConnectorScriptUrl: '/api/connector/script' }))
const task: FolderImportTask = {
  id: 'task-unique', name: '我的研究资料', kind: 'local', path: '', folderId: 'topic',
  includeSubfolders: true, preserveHierarchy: false, schedule: { frequency: 'daily', time: '08:00', timezone: 'Asia/Shanghai', weekday: 0 },
  maxFileMb: 100, maxFilesPerScan: 1000, dailyFileLimit: 1000, paused: false, status: 'offline', connectorOnline: false,
}
const writeText = vi.fn()
const mount = (props: Partial<Parameters<typeof FolderImportConnection>[0]> = {}) => render(<FolderImportConnection task={task} pairing={{ code: 'SINGLE-USE-CODE', expiresAt: new Date(Date.now() + 600000).toISOString() }} busy={false} writable onClose={vi.fn()} onPair={vi.fn()} {...props} />)

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

describe('folder connector setup', () => {
  it('requires a real path and copies a shell-safe command without persisting the connection code', async () => {
    mount()
    expect(screen.getByRole('button', { name: '复制连接命令' })).toBeDisabled()
    expect(screen.getByRole('link', { name: '下载电脑连接程序' })).toHaveAttribute('href', '/api/connector/script')
    fireEvent.click(screen.getByRole('button', { name: 'Mac / Linux' }))
    fireEvent.change(screen.getByRole('textbox', { name: '本机文件夹路径' }), { target: { value: "/Users/reader/O'Connor/$papers $(echo test)" } })
    fireEvent.click(screen.getByRole('button', { name: '复制连接命令' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0][0]).toContain("--folder '/Users/reader/O'\\''Connor/$papers $(echo test)'")
    expect(writeText.mock.calls[0][0]).toContain("--config '~/.mberp/folder-task-unique.json'")
    expect(await screen.findByRole('status')).toHaveTextContent('已复制')
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('quotes Windows paths for PowerShell and rejects relative paths', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Windows' }))
    fireEvent.change(screen.getByRole('textbox', { name: '本机文件夹路径' }), { target: { value: "C:\\Users\\O'Connor\\$papers" } })
    fireEvent.click(screen.getByRole('button', { name: '复制连接命令' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0][0]).toMatch(/^py -3 /)
    expect(writeText.mock.calls[0][0]).toContain("--folder 'C:\\Users\\O''Connor\\$papers'")
    fireEvent.change(screen.getByRole('textbox', { name: '本机文件夹路径' }), { target: { value: 'relative/path' } })
    expect(screen.getByRole('button', { name: '复制连接命令' })).toBeDisabled()
  })
  it('explains manual copying if the clipboard is unavailable', async () => {
    writeText.mockRejectedValue(new Error('Permission denied'))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Mac / Linux' }))
    fireEvent.change(screen.getByRole('textbox', { name: '本机文件夹路径' }), { target: { value: '/Users/reader/Papers' } })
    fireEvent.click(screen.getByRole('button', { name: '复制连接命令' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('复制未成功，请展开“查看运行命令”手动复制')
  })
  it('does not offer to copy an expired code and permits regeneration', () => {
    const onPair = vi.fn()
    mount({ pairing: { code: 'EXPIRED-CODE', expiresAt: new Date(Date.now() - 1000).toISOString() }, onPair })
    expect(screen.getByText('连接码已过期，重新生成后即可继续。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制连接命令' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '生成新的连接码' }))
    expect(onPair).toHaveBeenCalledOnce()
    expect(writeText).not.toHaveBeenCalled()
  })
  it('keeps a new pairing code visible even when the previous connector still reports online', () => {
    mount({ task: { ...task, connectorOnline: true } })
    expect(screen.getByText('SINGLE-USE-CODE')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '本机文件夹路径' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '电脑已连接' })).not.toBeInTheDocument()
  })
  it('shows the connected result only when there is no new pairing attempt', () => {
    const onClose = vi.fn()
    mount({ task: { ...task, connectorOnline: true }, pairing: null, onClose })
    expect(screen.getByRole('heading', { name: '电脑已连接' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '本机文件夹路径' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回查看导入进度' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
