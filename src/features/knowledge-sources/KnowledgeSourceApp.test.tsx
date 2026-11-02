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
  localStorage.clear(); sessionStorage.clear()
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
const savedVersion = { id: 'saved', sha256: 'a'.repeat(64), size: 100, createdAt: '2026-11-01T10:00:00Z', parseStatus: 'ready', indexStatus: 'ready' }

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
  it('shows the source catalogue inline and explicitly downloads selected files without a dialog', async () => {
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    expect(screen.getByRole('heading', { name: /可下载论文/ })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看可下载论文' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '全选ICH本页论文' }))
    fireEvent.click(screen.getByRole('button', { name: /下载所选/ }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/jobs', { sourceId: 'ich', documentIds: ['newdoc'], folderId: 'ich', parse: true }))
    expect(screen.getByRole('heading', { name: '从来源下载' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看下载任务' }))
    expect(await screen.findByRole('heading', { name: '下载任务' })).toBeInTheDocument()
    expect(mocks.mutate).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('/information'), expect.anything())
  })
  it('refreshes the inline list and only marks server-confirmed new documents', async () => {
    mocks.mutate.mockImplementation(async () => {
      snapshot.documents.push({ ...snapshot.documents[0], id: 'fresh', title: '再次搜索发现的论文', isNew: true })
      return {}
    })
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    expect(screen.queryByLabelText('新发现')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '再次搜索' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/sources/ich/check', {}))
    expect(await screen.findByRole('checkbox', { name: '选择 再次搜索发现的论文' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('新发现')).toHaveLength(1)
    expect(screen.getByLabelText('新发现').closest('article')).toHaveTextContent('再次搜索发现的论文')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('preserves the current catalogue while a source range reports an error', async () => {
    snapshot.sources[0].scopeStatus = { Q: { status: 'error', error: '搜索失败' } }
    snapshot.documents[0].isNew = true
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    expect(screen.getByText(/Q 范围搜索未成功，保留上次清单/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择 官方新指南' })).toBeInTheDocument()
    expect(screen.getByLabelText('新发现')).toBeInTheDocument()
  })
  it.each(['running', 'paused'])('keeps selections but blocks duplicate source jobs while %s', async status => {
    snapshot.jobs = [{ id: 'active-job', sourceId: 'ich', folderId: 'ich', kind: 'import', status, total: 1, processed: 0, saved: 0, failed: 0, pending: 1, parse: true, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', items: [] }]
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    fireEvent.click(within(screen.getByRole('group', { name: 'ICH分类筛选' })).getByRole('button', { name: 'Q 质量' }))
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    expect(screen.getByRole('button', { name: '下载所选（1）' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '等待当前任务结束' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '查看当前任务' })).toBeEnabled()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
  it('shows every folder including source archives and assigns selected papers directly', async () => {
    snapshot.folders.push({ id: 'empty', name: '上游工艺开发' }, { id: 'analysis', name: '分析方法质量表征' }, { id: 'fifth', name: '第五个分类' })
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    const folders = screen.getByRole('region', { name: /^论文文件夹\s*\d/ })
    expect(within(folders).getAllByRole('listitem')).toHaveLength(5)
    expect(within(folders).getByRole('listitem', { name: '文件夹 ICH' })).toHaveTextContent('来源归档')
    expect(within(folders).getByRole('listitem', { name: '文件夹 上游工艺开发' })).toHaveTextContent('空文件夹')
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 已有研究论文' }))
    expect(within(folders).getByRole('button', { name: '所选论文已全部在 稳定性研究' })).toBeDisabled()
    fireEvent.click(within(folders).getByRole('button', { name: '将选中的 1 篇论文放入 ICH' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/papers/folders', { paperIds: ['sources/existing.md'], folderIds: ['ich'], mode: 'add', revision: 4 }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择 已有研究论文' })).not.toBeChecked())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('filters folder names and lets users rename a folder independently of opening it', async () => {
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    const folders = screen.getByRole('region', { name: /^论文文件夹\s*\d/ })
    fireEvent.change(within(folders).getByRole('searchbox', { name: '搜索文件夹' }), { target: { value: 'ICH' } })
    expect(within(folders).getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(within(folders).getByRole('button', { name: '重命名文件夹 ICH' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('重命名文件夹')
    expect(screen.getByRole('heading', { name: '全部论文' })).toBeInTheDocument()
  })
  it('selects only the displayed catalogue page and retains selection when changing pages', async () => {
    snapshot.documents = Array.from({ length: 30 }, (_, index) => ({ ...snapshot.documents[0], id: `d${index}`, title: `指南 ${String(index).padStart(2, '0')}` }))
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: '全选ICH本页论文' }))
    expect(screen.getByRole('button', { name: '下载所选（25）' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }))
    expect(screen.getByRole('checkbox', { name: '全选ICH本页论文' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '下载所选（25）' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下载所选（25）' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/jobs', expect.objectContaining({ documentIds: Array.from({ length: 25 }, (_, index) => `d${index}`) })))
  })
  it('selects the whole category across pages while page deselection remains limited to that page', async () => {
    const document = snapshot.documents[0]
    snapshot.documents = [
      ...Array.from({ length: 32 }, (_, index) => ({ ...document, id: `q${index}`, title: `Q 指南 ${String(index).padStart(2, '0')}`, versions: index === 31 ? [savedVersion] : [] })),
      { ...document, id: 's-only', title: 'S 指南', scopes: ['S'] },
      { ...document, id: 'other-source', title: '其他来源的 Q 指南', sourceId: 'another-source' },
    ]
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    expect(screen.getByRole('button', { name: '全选本类' })).toBeDisabled()
    fireEvent.click(within(screen.getByRole('group', { name: 'ICH分类筛选' })).getByRole('button', { name: 'Q 质量' }))
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    expect(screen.getByRole('button', { name: '下载所选（31）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全选本类' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }))
    expect(screen.getByRole('checkbox', { name: '全选ICH本页论文' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: '全选ICH本页论文' }))
    expect(screen.getByRole('button', { name: '下载所选（25）' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    fireEvent.click(screen.getByRole('button', { name: '下载所选（31）' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/jobs', expect.objectContaining({ sourceId: 'ich', folderId: 'ich', parse: true, documentIds: expect.any(Array) })))
    const body = mocks.mutate.mock.calls.find(call => call[1] === '/jobs')![2] as { documentIds: string[] }
    expect(body.documentIds).toHaveLength(31)
    expect(new Set(body.documentIds)).toEqual(new Set(Array.from({ length: 31 }, (_, index) => `q${index}`)))
  })
  it('adds another category without losing earlier choices or duplicating shared documents', async () => {
    const document = snapshot.documents[0]
    snapshot.documents = [
      ...Array.from({ length: 30 }, (_, index) => ({ ...document, id: `q${index}`, title: `Q 指南 ${index}` })),
      { ...document, id: 'shared', title: '共享指南', scopes: ['Q', 'S'] },
      { ...document, id: 's0', title: 'S 指南 0', scopes: ['S'] },
      { ...document, id: 's1', title: 'S 指南 1', scopes: ['S'] },
      { ...document, id: 'e-only', title: 'E 指南', scopes: ['E'] },
    ]
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    const scopes = screen.getByRole('group', { name: 'ICH分类筛选' })
    fireEvent.click(within(scopes).getByRole('button', { name: 'Q 质量' }))
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    fireEvent.click(within(scopes).getByRole('button', { name: 'S 安全性' }))
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    fireEvent.click(screen.getByRole('button', { name: '下载所选（33）' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/jobs', expect.objectContaining({ documentIds: expect.any(Array) })))
    const body = mocks.mutate.mock.calls.find(call => call[1] === '/jobs')![2] as { documentIds: string[] }
    expect(body.documentIds).toHaveLength(33)
    expect(new Set(body.documentIds)).toEqual(new Set([...Array.from({ length: 30 }, (_, index) => `q${index}`), 'shared', 's0', 's1']))
  })
  it('applies keyword and download-status filters when selecting a category', async () => {
    const document = snapshot.documents[0]
    snapshot.documents = [
      { ...document, id: 'target', title: '目标指南' },
      { ...document, id: 'saved-target', title: '目标指南已保存', versions: [savedVersion] },
      { ...document, id: 'non-match', title: '其他指南' },
      { ...document, id: 'e-target', title: '目标 E 指南', scopes: ['E'] },
    ]
    mount(); await screen.findByRole('button', { name: /已有研究论文/ })
    fireEvent.click(screen.getByRole('button', { name: /论文搜索源/ }))
    fireEvent.click(within(screen.getByRole('group', { name: 'ICH分类筛选' })).getByRole('button', { name: 'Q 质量' }))
    fireEvent.change(screen.getByRole('textbox', { name: '筛选ICH已发现论文' }), { target: { value: '目标' } })
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    expect(screen.getByRole('button', { name: '下载所选（1）' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'ICH下载状态' }), { target: { value: 'all' } })
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    fireEvent.click(screen.getByRole('button', { name: '下载所选（2）' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('post', '/jobs', expect.objectContaining({ documentIds: expect.any(Array) })))
    const body = mocks.mutate.mock.calls.find(call => call[1] === '/jobs')![2] as { documentIds: string[] }
    expect(new Set(body.documentIds)).toEqual(new Set(['target', 'saved-target']))
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
    expect(screen.queryByRole('button', { name: '再次搜索' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全选本类' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /下载所选/ })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择 官方新指南' })).toBeDisabled()
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
