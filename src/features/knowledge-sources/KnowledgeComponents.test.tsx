import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderHook, act } from '@testing-library/react'
import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DuplicateReview from './DuplicateReview'
import PaperMetadataEditor from './PaperMetadataEditor'
import PdfReader from './PdfReader'
import SharedPaperTags from './SharedPaperTags'
import { defaultCatalogState, isGuideline, restoreCatalog, saveCatalog } from './catalog-state'
import { deleteFolderImport, getFolderImportRun } from './folder-import-api'
import { useKnowledgePreference } from './preferences'
import * as v3Api from './v3-api'
import type { PaperDetail } from './v3-api'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))

const sampleDetail = (overrides: Partial<PaperDetail> = {}): PaperDetail => ({
  paper: {
    id: 'sources/paper-1.md',
    title: 'ICH Q1A Stability',
    authors: ['Alice', 'Bob'],
    year: '2026',
    doi: '10.1000/q1a',
    abstract: 'Stability protocol summary',
    folderIds: ['f1'],
    saved: true,
    indexStatus: 'ready',
    tags: [{ id: '稳定性', name: '稳定性' }],
  },
  canWrite: true,
  metadataRevision: 3,
  insightRevision: 4,
  ...overrides,
})

describe('Phase 2 core Knowledge Sources components and utilities', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('useKnowledgePreference persists typed state and recovers from malformed JSON', () => {
    localStorage.setItem('ks:corrupt', '{not-json')
    const { result } = renderHook(() => useKnowledgePreference<string[]>('ks:corrupt', ['default']))
    expect(result.current[0]).toEqual(['default'])
    act(() => {
      result.current[1](['alpha', 'beta'])
    })
    expect(result.current[0]).toEqual(['alpha', 'beta'])
    expect(JSON.parse(localStorage.getItem('ks:corrupt') || '[]')).toEqual(['alpha', 'beta'])
  })

  it('catalog-state filters stale IDs/scopes and detects official guideline types', () => {
    const docs = [
      {
        id: 'd1',
        sourceId: 's1',
        title: 'Q1A',
        url: 'https://www.ich.org/q1a.pdf',
        scopes: ['Q'],
        folderIds: [],
        format: 'PDF',
        language: 'en',
        documentType: 'Guideline (Final)',
        discoveredAt: '2026-11-20T00:00:00Z',
        status: 'discovered',
        versions: [],
      },
    ]
    saveCatalog('user-1', 'ich', {
      ...defaultCatalogState(),
      scope: 'INVALID_SCOPE',
      chosen: ['d1', 'deleted-doc', 'd1'],
      destination: 'removed-folder',
      page: 2,
    })
    const restored = restoreCatalog('user-1', 'ich', docs, ['Q', 'S'], ['f1'])
    expect(restored.scope).toBe('all')
    expect(restored.chosen).toEqual(['d1'])
    expect(restored.destination).toBe('')
    expect(restored.page).toBe(2)
    expect(isGuideline(docs[0])).toBe(true)
  })

  it('PaperMetadataEditor preserves metadata map keys and submits split authors', async () => {
    const onSaved = vi.fn()
    const postSpy = vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue({ saved: true })
    render(<PaperMetadataEditor detail={sampleDetail()} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('button', { name: '补充资料信息' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '  Updated Q1A  ' } })
    fireEvent.change(screen.getByLabelText('作者（分号分隔）'), {
      target: { value: 'Alice；Charlie; ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存资料信息' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(postSpy).toHaveBeenCalledWith('/library/metadata', {
      paperId: 'sources/paper-1.md',
      revision: 3,
      metadata: {
        title: 'Updated Q1A',
        authors: ['Alice', 'Charlie'],
        year: '2026',
        doi: '10.1000/q1a',
        abstract: 'Stability protocol summary',
      },
    })
  })

  it('SharedPaperTags submits normalized tag list for writable Core papers and hides form for archive-only', async () => {
    const onSaved = vi.fn()
    const postSpy = vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue({ saved: true })
    const { rerender } = render(<SharedPaperTags detail={sampleDetail()} onSaved={onSaved} />)
    fireEvent.change(screen.getByPlaceholderText('稳定性；生物制品'), {
      target: { value: '稳定性； 质量控制 ; ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存共享标签' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(postSpy).toHaveBeenCalledWith('/library/tags', {
      paperIds: ['sources/paper-1.md'],
      tags: ['稳定性', '质量控制'],
      revision: 4,
    })

    rerender(
      <SharedPaperTags
        detail={sampleDetail({
          paper: { ...sampleDetail().paper, id: 'archive:v1', tags: [] },
        })}
        onSaved={onSaved}
      />,
    )
    expect(screen.queryByRole('button', { name: '保存共享标签' })).not.toBeInTheDocument()
    expect(screen.getByText('尚无共享标签')).toBeInTheDocument()
  })

  it('DuplicateReview loads groups, sanitizes unsafe usage URLs, and organizes into target folder', async () => {
    vi.spyOn(v3Api, 'knowledgeV3Get').mockResolvedValue({
      groups: [
        {
          id: 'g1',
          reason: 'DOI 相同',
          sameDocumentVersions: false,
          papers: [
            { id: 'sources/a.md', title: 'Paper A', folderIds: [] },
            { id: 'sources/b.md', title: 'Paper B', folderIds: [] },
          ],
        },
      ],
    })
    vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue({
      folderIds: ['f1'],
      items: [
        { id: 'n1', kind: 'note', title: 'Safe Note', url: '/notes?note=n1' },
        { id: 'n2', kind: 'report', title: 'Unsafe Script', url: 'javascript:alert(1)' },
      ],
    })
    const onOrganize = vi.fn().mockResolvedValue(true)
    const onOpen = vi.fn()
    render(
      <DuplicateReview
        folders={[{ id: 'f1', name: '质量指南' }]}
        canOrganize={true}
        onOrganize={onOrganize}
        onOpen={onOpen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '查找重复候选' }))
    expect(await screen.findByText('DOI 相同')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '汇总本组分类与本人笔记' }))
    const safeLink = await screen.findByRole('link', { name: '笔记：Safe Note' })
    expect(safeLink).toHaveAttribute('href', '/notes?note=n1')
    expect(screen.queryByRole('link', { name: '报告：Unsafe Script' })).not.toBeInTheDocument()
    expect(screen.getByText('报告：Unsafe Script')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'f1' } })
    fireEvent.click(screen.getByRole('button', { name: '将本组加入目标文件夹' }))
    await waitFor(() => expect(onOrganize).toHaveBeenCalledWith(['sources/a.md', 'sources/b.md'], 'f1', false))
  })

  it('PdfReader dispatches portal:unauthorized on 401 and surfaces >25MB fallback link', async () => {
    const unauthorized = vi.fn()
    window.addEventListener('portal:unauthorized', unauthorized)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response('%PDF-1.4', {
          status: 200,
          headers: { 'content-length': String(30 * 1024 * 1024) },
        }),
      )

    const { rerender } = render(<PdfReader url="/api/v1/p1.pdf" title="Doc 1" />)
    await waitFor(() => expect(unauthorized).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('原件暂不可读')

    rerender(<PdfReader url="/api/v1/p2.pdf" title="Doc 2" />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('原件超过25MB，请打开原件阅读')
    expect(screen.getByRole('link', { name: '打开原件' })).toHaveAttribute('href', '/api/v1/p2.pdf')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    window.removeEventListener('portal:unauthorized', unauthorized)
  })

  it('folder-import-api aligns deleteFolderImport { task } contract and preserves run warning/truncated', async () => {
    const reqSpy = vi
      .spyOn(axios.Axios.prototype, 'request')
      .mockResolvedValueOnce({ data: { task: { id: 't1', name: 'NAS', paused: true, status: 'paused' } } })
      .mockResolvedValueOnce({
        data: {
          run: {
            id: 'r1',
            task_id: 't1',
            status: 'transferring',
            phase: 'transfer',
            created_at: '2026-11-22T00:00:00Z',
            total: 1000,
            processed: 0,
            completed: 0,
            failed: 0,
            new: 1000,
            updated: 0,
            unchanged: 0,
            truncated: true,
            warning: '本次达到文件数量上限；其余文件将在后续批次继续扫描',
          },
          items: [],
        },
      })

    const deleted = await deleteFolderImport('t1')
    expect(deleted.task.id).toBe('t1')

    const runDetail = await getFolderImportRun('r1')
    expect(runDetail.run.truncated).toBe(true)
    expect(runDetail.run.warning).toBe('本次达到文件数量上限；其余文件将在后续批次继续扫描')
    expect(reqSpy).toHaveBeenCalledTimes(2)
  })
})
