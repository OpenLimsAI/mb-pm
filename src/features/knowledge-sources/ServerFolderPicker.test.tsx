import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FolderImportSettings from './FolderImportSettings'
import type { FolderImportBootstrap } from './folder-import-api'

const api = vi.hoisted(() => ({ list: vi.fn(), probe: vi.fn(), save: vi.fn() }))
vi.mock('./folder-import-api', () => ({
  listFolderImportDirectories: api.list, probeFolderImport: api.probe, saveFolderImport: api.save,
}))
const roots = [{ id: 'research', name: '研究共享目录' }, { id: 'other', name: '其他目录' }]
const bootstrap: FolderImportBootstrap = { roots, tasks: [], canWrite: true, workerEnabled: true, maxFileMb: 100, connectorOnlineSeconds: 90 }
const settings = { bootstrap, folders: [{ id: 'target', name: '研究资料', writable: true }], initialFolderId: 'target', canManage: true, onClose: vi.fn(), onSaved: vi.fn() }
const button = (name: string) => screen.getByRole('button', { name })
const server = () => fireEvent.click(screen.getByRole('radio', { name: '服务器 / NAS' }))
const choose = () => fireEvent.click(button('选择服务器文件夹'))
const folderPath = () => screen.getByRole('textbox', { name: '服务器子目录' })
const rootSelect = () => screen.getByRole('combobox', { name: '服务器已连接目录' })
const listing = (...directories: string[]) => ({ directories, truncated: false })

beforeEach(() => {
  vi.resetAllMocks()
  api.probe.mockResolvedValue({ valid: true, fileCount: 10, totalBytes: 10000 })
  api.save.mockResolvedValue({ task: { id: 'new-task' } })
})

describe('server source folder selection', () => {
  it('opens nested folders, goes back and selects a leaf for the actual scan', async () => {
    api.list.mockImplementation(async (_root, path) => path === '' ? listing('药典 & 指南') : path === '药典 & 指南' ? listing('2026') : listing())
    render(<FolderImportSettings {...settings} />)
    server(); choose()
    expect(button('开始导入')).toBeDisabled()
    expect(button('上一级')).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: '药典 & 指南' }))
    fireEvent.click(await screen.findByRole('button', { name: '2026' }))
    expect(await screen.findByText(/没有可浏览的子文件夹/)).toBeVisible()
    fireEvent.click(button('上一级'))
    fireEvent.click(await screen.findByRole('button', { name: '2026' }))
    await screen.findByText(/没有可浏览的子文件夹/)
    fireEvent.click(button('使用当前文件夹'))
    expect(folderPath()).toHaveValue('药典 & 指南/2026')
    fireEvent.click(button('开始导入'))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'server', serverRootId: 'research', path: '药典 & 指南/2026', folderId: 'target' }), undefined))
  })

  it('can select the whole shared folder and clears a previous source path when switching roots or source type', async () => {
    api.list.mockResolvedValue(listing())
    render(<FolderImportSettings {...settings} />)
    server()
    fireEvent.change(folderPath(), { target: { value: '旧来源' } })
    fireEvent.change(rootSelect(), { target: { value: 'other' } })
    expect(folderPath()).toHaveValue('')
    choose()
    await screen.findByText(/没有可浏览的子文件夹/)
    fireEvent.click(button('使用当前文件夹'))
    expect(folderPath()).toHaveValue('')
    fireEvent.change(folderPath(), { target: { value: '另一个目录' } })
    fireEvent.click(screen.getByRole('radio', { name: '我的电脑' }))
    server()
    expect(folderPath()).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '自动导入目标文件夹' })).toHaveValue('target')
  })

  it('discards a delayed listing from a superseded root', async () => {
    let complete!: (result: ReturnType<typeof listing>) => void
    api.list.mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValue(listing('新目录'))
    render(<FolderImportSettings {...settings} />)
    server(); choose()
    const originalSignal: AbortSignal = api.list.mock.calls[0][2]
    fireEvent.change(rootSelect(), { target: { value: 'other' } })
    expect(originalSignal.aborted).toBe(true)
    choose()
    await screen.findByRole('button', { name: '新目录' })
    await act(async () => complete(listing('过期的目录')))
    expect(screen.queryByRole('button', { name: '过期的目录' })).not.toBeInTheDocument()
  })

  it('finds folders beyond a truncated listing and keeps the search separate from submitting the import', async () => {
    api.list.mockImplementation(async (_root, path, _signal, query) => path ? listing() : query === '药典' ? listing('药典文献') : { ...listing('财务'), truncated: true })
    render(<FolderImportSettings {...settings} />)
    server(); choose()
    const search = await screen.findByRole('textbox', { name: '查找当前目录中的子文件夹' })
    fireEvent.change(search, { target: { value: '药典' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: '药典文献' }))
    await screen.findByText(/没有可浏览的子文件夹/)
    fireEvent.click(button('使用当前文件夹'))
    expect(folderPath()).toHaveValue('药典文献')
    expect(button('选择服务器文件夹')).toHaveFocus()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('displays an access error separately from an empty directory, supports retry and preserves the saved selection on cancellation', async () => {
    api.list.mockRejectedValueOnce({ isAxiosError: true, response: { status: 403, data: { detail: '目录无读取权限' } } })
      .mockResolvedValueOnce(listing('资料')).mockResolvedValueOnce(listing())
    render(<FolderImportSettings {...settings} />)
    server(); choose()
    expect(await screen.findByRole('alert')).toHaveTextContent('目录无读取权限')
    expect(button('使用当前文件夹')).toBeDisabled()
    fireEvent.click(button('重试'))
    fireEvent.click(await screen.findByRole('button', { name: '资料' }))
    await screen.findByText(/没有可浏览的子文件夹/)
    fireEvent.click(button('收起'))
    expect(folderPath()).toHaveValue('')
  })

  it('shows how to reconnect an empty source list and makes newly connected roots selectable in the same form', async () => {
    const onRefreshRoots = vi.fn().mockResolvedValue(undefined)
    const view = render(<FolderImportSettings {...settings} bootstrap={{ ...bootstrap, roots: [] }} onRefreshRoots={onRefreshRoots} />)
    server()
    expect(screen.getByText('尚无已连接目录')).toBeVisible()
    expect(screen.queryByRole('combobox', { name: '服务器已连接目录' })).not.toBeInTheDocument()
    expect(button('开始导入')).toBeDisabled()
    fireEvent.click(button('刷新目录列表'))
    await waitFor(() => expect(onRefreshRoots).toHaveBeenCalledOnce())
    view.rerender(<FolderImportSettings {...settings} onRefreshRoots={onRefreshRoots} />)
    expect(rootSelect()).toHaveValue('research')
    expect(button('选择服务器文件夹')).toBeEnabled()
    fireEvent.click(button('开始导入'))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ serverRootId: 'research', path: '' }), undefined))
  })

  it.each([
    ['/srv/research/USP_EP/', ''],
    ['/srv/research/USP_EP/欧洲 药典/2026', '欧洲 药典/2026'],
  ])('maps a pasted full path %s to the most specific shared root and sends only the relative suffix', async (full, relative) => {
    const configured = [{ ...roots[0], displayPath: '/srv/research' }, { ...roots[1], displayPath: '/srv/research/USP_EP' }]
    render(<FolderImportSettings {...settings} bootstrap={{ ...bootstrap, roots: configured }} />)
    server()
    expect(screen.getByText('/srv/research')).toBeVisible()
    fireEvent.change(folderPath(), { target: { value: full } })
    expect(rootSelect()).toHaveValue('other')
    expect(screen.getByText(full.replace(/\/$/, ''))).toBeVisible()
    fireEvent.click(button('开始导入'))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ serverRootId: 'other', path: relative }), undefined))
    expect(api.probe.mock.calls[0][0]).toMatchObject({ serverRootId: 'other', path: relative })
  })

  it('prevents checking and saving out-of-root paths and allows recovery by browsing an authorized directory', async () => {
    const root = { ...roots[0], displayPath: '/srv/research/USP_EP', path: '/internal/read-only' }
    api.list.mockResolvedValueOnce(listing('欧洲药典')).mockResolvedValueOnce(listing())
    render(<FolderImportSettings {...settings} bootstrap={{ ...bootstrap, roots: [root] }} />)
    server()
    for (const invalid of ['/srv/research/USP_EP_backup', '/other/USP_EP', '/srv/research/USP_EP/../private', '../private', '/internal/read-only']) {
      fireEvent.change(folderPath(), { target: { value: invalid } })
      expect(folderPath()).toHaveAttribute('aria-invalid', 'true')
      expect(button('开始导入')).toBeDisabled()
      expect(button('检查目录')).toBeDisabled()
    }
    choose()
    fireEvent.click(await screen.findByRole('button', { name: '欧洲药典' }))
    await screen.findByText(/没有可浏览的子文件夹/)
    expect(screen.getByText('/srv/research/USP_EP/欧洲药典')).toBeVisible()
    fireEvent.click(button('使用当前文件夹'))
    expect(screen.getByText('/srv/research/USP_EP/欧洲药典')).toBeVisible()
    expect(folderPath()).toHaveValue('欧洲药典')
    expect(api.probe).not.toHaveBeenCalled()
  })

  it('keeps unnamed physical paths private and accepts relative paths on legacy roots', async () => {
    const root = { ...roots[0], path: '/internal/mount' }
    render(<FolderImportSettings {...settings} bootstrap={{ ...bootstrap, roots: [root] }} />)
    server()
    expect(screen.queryByText('/internal/mount')).not.toBeInTheDocument()
    fireEvent.change(folderPath(), { target: { value: '/internal/mount' } })
    expect(screen.getByRole('alert')).toHaveTextContent('未提供服务器完整路径')
    expect(button('开始导入')).toBeDisabled()
    fireEvent.change(folderPath(), { target: { value: 'papers' } })
    expect(screen.getByText('研究共享目录 / papers')).toBeVisible()
    fireEvent.click(button('开始导入'))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ serverRootId: 'research', path: 'papers' }), undefined))
  })
})
