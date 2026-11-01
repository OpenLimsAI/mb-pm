import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import KnowledgeSourceApp from './KnowledgeSourceApp'
import type { KnowledgeSourceSnapshot } from './api'

const mocks = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn(), preview: false, allowed: true }))
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), getKnowledgeSources: mocks.get, mutateKnowledgeSources: mocks.mutate }))
vi.mock('../../components/portal/context', () => ({ usePortalContext: () => ({ user: { id: 'person', username: 'reader', displayName: '同事' }, identityNamespace: 'verified-user', preview: mocks.preview, applications: [{ id: 'knowledge-sources', enabled: mocks.allowed }] }) }))

let snapshot: KnowledgeSourceSnapshot
beforeEach(() => {
  mocks.preview = false; mocks.allowed = true
  snapshot = {
    papers: [{ id: 'sources/existing.md', title: '已有研究论文', sourceName: '知识库', folderIds: ['topic'], saved: false, indexStatus: 'unknown', kbUrl: 'https://kb.openlims.ai/?paper=existing' }, { id: 'archive:version', title: '已下载的ICH指南', sourceName: 'ICH', sourceId: 'ich', folderIds: ['ich'], saved: true, indexStatus: 'failed', originalUrl: '/api/v1/knowledge-sources/documents/doc/versions/v/original', documentId: 'doc', versionId: 'v', createdAt: '2026-11-01T10:00:00Z' }],
    folders: [{ id: 'topic', name: '稳定性研究', writable: true }, { id: 'ich', name: 'ICH', writable: true }],
    sources: [{ id: 'ich', name: 'ICH', url: 'https://www.ich.org', scopes: ['Q', 'S', 'E', 'M'], folderId: 'ich', frequency: 'daily', enabled: false, adapter: 'ich', status: 'ok', scopeStatus: {}, lastCheckedAt: '2026-11-01T10:00:00Z' }],
    documents: [{ id: 'newdoc', sourceId: 'ich', title: '官方新指南', url: 'https://database.ich.org/sites/default/files/new.pdf', scopes: ['Q'], folderIds: [], format: 'PDF', language: '英文', documentType: 'Guideline', discoveredAt: '2026-11-01T10:00:00Z', status: 'discovered', versions: [] }],
    jobs: [], catalogRevision: 4, canManage: true, canOrganize: true, starred: [], integration: { status: 'ready', message: '已连接' },
  }
  mocks.get.mockReset().mockImplementation(() => Promise.resolve(structuredClone(snapshot)))
  mocks.mutate.mockReset().mockResolvedValue({})
})
const mount = () => render(<MemoryRouter><KnowledgeSourceApp /></MemoryRouter>)

describe('knowledge source real-data application', () => {
  it('lists existing KB papers and archived files without treating discovery as saved or unknown indexing as ready', async () => {
    mount()
    expect(await screen.findByRole('button', { name: /已有研究论文/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: '同事 · 我的设置' })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('button', { name: '切换主题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /已下载的ICH指南/ })).toBeInTheDocument()
    expect(screen.queryByText('官方新指南')).not.toBeInTheDocument()
    expect(screen.getByText('索引状态待确认')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).queryByText('可问答')).not.toBeInTheDocument()
  })
  it('only includes confirmed server originals in recent downloads', async () => {
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: '最近下载' }))
    expect(screen.queryByRole('button', { name: /已有研究论文/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /已下载的ICH指南/ })).toBeInTheDocument()
  })
  it('writes shared multi-folder classification with the revision and does not duplicate a paper', async () => {
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 已有研究论文' }))
    fireEvent.click(within(screen.getByRole('group', { name: '批量论文操作' })).getByRole('button', { name: '放入文件夹' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /ICH/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/papers/folders', expect.objectContaining({ paperIds: ['sources/existing.md'], folderIds: ['ich'], mode: 'add', revision: 4 })))
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })
  it('previews official discovered files and explicitly starts a persistent server download in the source folder', async () => {
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    fireEvent.click(screen.getByRole('button', { name: '查看可下载论文' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '全选未下载论文' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '开始下载到服务器' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/jobs', { sourceId: 'ich', documentIds: ['newdoc'], folderId: 'ich', parse: true }))
    expect(await screen.findByRole('heading', { name: '下载任务' })).toBeInTheDocument()
    expect(mocks.mutate).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('/information'), expect.anything())
  })
  it('keeps a failed write dialog open and does not report success', async () => {
    mocks.mutate.mockRejectedValue(new Error('offline'))
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getAllByRole('button', { name: '新建文件夹' })[0])
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新专题' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法完成操作')
    expect(screen.queryByText('文件夹已保存。')).not.toBeInTheDocument()
  })
  it('does not expose shared folder write controls for read-only users', async () => {
    snapshot.canOrganize = false; snapshot.canManage = false
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    expect(screen.queryByRole('button', { name: '新建文件夹' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '放入文件夹' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    expect(screen.queryByRole('button', { name: '查看可下载论文' })).not.toBeInTheDocument()
  })
  it('shows real empty and unavailable states without demonstration papers', async () => {
    snapshot.papers = []; snapshot.folders = []; snapshot.documents = []
    snapshot.integration = { status: 'unavailable', message: '知识库连接暂不可用' }
    mount()
    expect(await screen.findByText('知识库连接暂不可用')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '还没有已保存的论文' })).toBeInTheDocument()
    expect(screen.queryByText('质量风险管理')).not.toBeInTheDocument()
  })
  it.each(['preview', 'denied'])('does not call production data for %s', async mode => {
    mocks.preview = mode === 'preview'; mocks.allowed = mode !== 'denied'
    mount()
    expect(await screen.findByRole('heading', { name: mode === 'preview' ? '知识源界面预览' : '知识源暂不可用' })).toBeInTheDocument()
    expect(mocks.get).not.toHaveBeenCalled()
  })
})
