import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SourceManager from './SourceManager'
import type { KnowledgeSourceSnapshot, SourceDocument } from './api'

const version = { id: 'version', sha256: 'a'.repeat(64), size: 100, createdAt: '2026-11-01T10:00:00Z', parseStatus: 'ready', indexStatus: 'ready' }
const doc = (id: string, extra: Partial<SourceDocument> = {}): SourceDocument => ({ id, title: id, sourceId: 'ich', url: 'https://database.ich.org/sites/default/files/test.pdf', scopes: ['Q'], folderIds: [], format: 'PDF', language: '英文', documentType: 'Guideline', discoveredAt: '2026-11-01T10:00:00Z', status: 'discovered', versions: [], ...extra })
let data: KnowledgeSourceSnapshot
const mutate = vi.fn()
const mount = (key?: string) => render(<div id="knowledge-source-app"><SourceManager data={data} busy={false} mutate={mutate} onAdd={vi.fn()} onDownloads={vi.fn()} storageKey={key} /></div>)
beforeEach(() => {
  localStorage.clear()
  mutate.mockReset().mockResolvedValue(true)
  data = { papers: [], folders: [{ id: 'ich', name: 'ICH' }, { id: 'topic', name: '稳定性研究' }], sources: [{ id: 'ich', name: 'ICH', url: 'https://www.ich.org', scopes: ['Q', 'S', 'E', 'M'], folderId: 'ich', frequency: 'daily', enabled: false, adapter: 'ich', status: 'ok', scopeStatus: {} }], documents: [doc('Q 正文', { isNew: true, unread: true }), doc('Q 培训', { documentType: 'Training', isNew: true }), doc('Q 已保存', { versions: [version], isNew: true, versionStatus: 'update_available' }), doc('S 正文', { scopes: ['S'] })], jobs: [], catalogRevision: 0, canManage: true, canOrganize: true, starred: [], integration: { status: 'ready', message: '' } }
})
const category = (label: string) => within(screen.getByRole('group', { name: 'ICH分类筛选' })).getByRole('button', { name: label })

describe('source catalogue workflow', () => {
  it('combines novelty, download state, type and category without widening the selection', async () => {
    mount()
    fireEvent.click(category('Q 质量'))
    fireEvent.change(screen.getByRole('combobox', { name: 'ICH资料类型' }), { target: { value: 'guideline' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'ICH新增与查看状态' }), { target: { value: 'new' } })
    fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    fireEvent.click(screen.getByRole('button', { name: '下载所选（1）' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('post', '/jobs', { sourceId: 'ich', documentIds: ['Q 正文'], folderId: 'ich', parse: true }, expect.any(String)))
  })
  it('reviews selected files across filters and removes only the chosen category', () => {
    mount()
    fireEvent.click(category('Q 质量')); fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    fireEvent.click(category('S 安全性')); fireEvent.click(screen.getByRole('button', { name: '全选本类' }))
    expect(screen.getByRole('region', { name: 'ICH已选清单汇总' })).toHaveTextContent('共选 3 份')
    fireEvent.click(screen.getByRole('button', { name: '仅看已选' }))
    expect(screen.getByRole('checkbox', { name: '选择 Q 正文' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '选择 S 正文' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: '选择 Q 已保存' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回筛选结果' }))
    fireEvent.click(screen.getByRole('button', { name: '取消本类选择' }))
    expect(screen.getByRole('button', { name: '下载所选（2）' })).toBeInTheDocument()
  })
  it('uses a temporary target and index choice without changing source settings', async () => {
    mount()
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Q 正文' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'ICH本次下载文件夹' }), { target: { value: 'topic' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '下载后加入知识库并建立问答索引' }))
    fireEvent.click(screen.getByRole('button', { name: '下载所选（1）' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('post', '/jobs', { sourceId: 'ich', documentIds: ['Q 正文'], folderId: 'topic', parse: false }, expect.any(String)))
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(data.sources[0].folderId).toBe('ich')
  })
  it('restores identity-scoped selections and filters while dropping no-longer-visible ids', () => {
    const first = mount('person-a')
    fireEvent.click(category('Q 质量'))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Q 正文' }))
    fireEvent.change(screen.getByRole('textbox', { name: '筛选ICH已发现论文' }), { target: { value: '正文' } })
    first.unmount()
    const second = mount('person-b')
    expect(screen.getByRole('textbox', { name: '筛选ICH已发现论文' })).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: '选择 Q 正文' })).not.toBeChecked()
    second.unmount()
    const third = mount('person-a')
    expect(screen.getByRole('textbox', { name: '筛选ICH已发现论文' })).toHaveValue('正文')
    expect(category('Q 质量')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('checkbox', { name: '选择 Q 正文' })).toBeChecked()
    third.unmount()
    data.documents = data.documents.filter(d => d.id !== 'Q 正文')
    mount('person-a')
    expect(screen.queryByRole('button', { name: '下载所选（1）' })).not.toBeInTheDocument()
  })
  it('persists the page and recovers safely when page count shrinks', () => {
    data.documents = Array.from({ length: 30 }, (_, i) => doc(`论文 ${String(i).padStart(2, '0')}`))
    const first = mount('person')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('共 30 份 · 第 2 / 2 页')).toBeInTheDocument()
    first.unmount()
    const second = mount('person')
    expect(screen.getByText('共 30 份 · 第 2 / 2 页')).toBeInTheDocument()
    second.unmount()
    data.documents = data.documents.slice(0, 1)
    mount('person')
    expect(screen.getByRole('checkbox', { name: '选择 论文 00' })).toBeInTheDocument()
  })
  it('saves explicit opt-in schedules and keeps indexing separate', async () => {
    mount()
    expect(screen.getByRole('combobox', { name: 'ICH定期检查频率', hidden: true })).toHaveValue('off')
    fireEvent.change(screen.getByRole('combobox', { name: 'ICH定期检查频率', hidden: true }), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '自动下载新发现及更新的文件', hidden: true }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置', hidden: true }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('patch', '/sources/ich', expect.objectContaining({ schedule: { frequency: 'weekly', downloadUpdates: true, indexUpdates: false } }), expect.any(String)))
  })
  it('separates unread from NEW and requests explicit version verification', async () => {
    mount()
    fireEvent.change(screen.getByRole('combobox', { name: 'ICH下载状态' }), { target: { value: 'update' } })
    expect(screen.getByRole('checkbox', { name: '选择 Q 已保存' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '选择 Q 正文' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '核验已保存版本' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('post', '/sources/ich/verify', {}, expect.any(String)))
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }))
    fireEvent.click(screen.getByRole('button', { name: '将 Q 正文 标为已查看' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('post', '/changes/read', { documentIds: ['Q 正文'] }, expect.any(String)))
  })
  it('does not present ICH-specific scheduling controls for unsupported sources', () => {
    data.sources = [{ ...data.sources[0], id: 'other', name: 'Other', adapter: 'unsupported', url: 'https://example.org' }]
    mount()
    expect(screen.getByText('仅登记 · 暂不能下载')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /定期检查频率/, hidden: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '再次搜索' })).not.toBeInTheDocument()
  })
  it('makes schedule and version actions unavailable to readers', () => {
    data.canManage = false
    mount()
    expect(screen.getByRole('combobox', { name: 'ICH定期检查频率', hidden: true })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: '自动下载新发现及更新的文件', hidden: true })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '核验已保存版本' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存设置', hidden: true })).not.toBeInTheDocument()
  })
  it('retains choices after failed submission and clears them only after acknowledgement', async () => {
    mutate.mockResolvedValue(false)
    const view = mount('person')
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Q 正文' }))
    fireEvent.click(screen.getByRole('button', { name: '下载所选（1）' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('checkbox', { name: '选择 Q 正文' })).toBeChecked()
    view.unmount()
    mount('person')
    expect(screen.getByRole('checkbox', { name: '选择 Q 正文' })).toBeChecked()
    mutate.mockResolvedValue(true)
    fireEvent.click(screen.getByRole('button', { name: '下载所选（1）' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择 Q 正文' })).not.toBeChecked())
  })
  it('ignores invalid cached values and limits recovered ids to the current source', () => {
    localStorage.setItem('kso:catalog:v2:person:ich', JSON.stringify({ scope: 'unknown', status: 'bad', page: -2, chosen: ['absent', 'Q 正文', 'Q 正文'], destination: 'deleted' }))
    mount('person')
    expect(category('全部分类')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('combobox', { name: 'ICH下载状态' })).toHaveValue('pending')
    expect(screen.getByRole('combobox', { name: 'ICH本次下载文件夹' })).toHaveValue('')
    expect(screen.getByRole('button', { name: '下载所选（1）' })).toBeInTheDocument()
  })

})

it('shows imported reference papers with empty ICH scopes and submits the selected PDF download', async () => {
  data.sources = [{ ...data.sources[0], id:'report-refs', name:'研究报告参考论文', adapter:'reference', scopes:[], folderId:null }]
  data.documents = [doc('ref-1',{sourceId:'report-refs',title:'从报告找到的论文',scopes:[],url:'https://example.org/paper'})]
  mount()
  expect(screen.getByRole('region',{name:'研究报告参考论文来源与论文'})).toBeInTheDocument()
  expect(screen.queryByRole('button',{name:'再次搜索'})).not.toBeInTheDocument()
  expect(screen.queryByText('该来源等待适配')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('checkbox',{name:'选择 从报告找到的论文'}))
  fireEvent.click(screen.getByRole('button',{name:'下载所选（1）'}))
  await waitFor(()=>expect(mutate).toHaveBeenCalledWith('post','/jobs',{sourceId:'report-refs',documentIds:['ref-1'],parse:true},expect.any(String)))
})
it('allows readers to view imported metadata without offering a download or ICH configuration',()=>{
  data.canManage=false
  data.sources = [{ ...data.sources[0], id:'assistant-refs', name:'个人AI助手参考论文', adapter:'reference', scopes:[], folderId:null }]
  data.documents = [doc('ref-2',{sourceId:'assistant-refs',title:'助手找到的论文',scopes:[]})]
  mount()
  expect(screen.getByText('助手找到的论文')).toBeInTheDocument()
  expect(screen.queryByRole('button',{name:/下载所选/})).not.toBeInTheDocument()
  expect(screen.getByText(/下载原文由具备知识库写入权限/)).toBeInTheDocument()
})
