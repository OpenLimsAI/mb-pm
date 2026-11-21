import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import axios, { AxiosError } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FolderMaintenance from './FolderMaintenance'
import ManualIndexPanel from './ManualIndexPanel'
import PaperDeleteDialog from './PaperDeleteDialog'
import { safeExternalHref, sourceError, type KnowledgeSourceSnapshot, type SourceFolder, type SourcePaper } from './api'
import { decodeKnowledgeV3, knowledgeV3Download } from './v3-api'
import * as v3Api from './v3-api'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Phase 1 Frontend Bug & Security Regressions', () => {
  it('FE-01: FolderMaintenance uses V3 folderCounts, excludes inbox/descendants, and blocks sourceDefault delete', () => {
    const folders: SourceFolder[] = [
      { id: 'root_a', name: '质量研究', kind: 'topic' },
      { id: 'child_a', name: '稳定性子目录', kind: 'topic', parentId: 'root_a' },
      { id: 'other_b', name: '工艺验证', kind: 'topic' },
      { id: 'inbox_1', name: '待整理', systemRole: 'inbox' },
    ]
    const snapshot: KnowledgeSourceSnapshot = {
      papers: [],
      folders,
      sources: [{ id: 's1', name: 'ICH', url: 'https://ich.org', scopes: ['Q'], enabled: false, folderId: 'root_a', frequency: 'daily', adapter: 'ich', status: 'ok', scopeStatus: {} }],
      jobs: [],
      documents: [],
      catalogRevision: 3,
      canManage: true,
      canOrganize: true,
      starred: [],
      libraryV3: true,
      folderCounts: { root_a: 17, other_b: 4 },
      integration: { status: 'ready', message: 'ok' },
    }
    render(<FolderMaintenance folder={folders[0]} data={snapshot} busy={false} mutate={vi.fn()} onRemoved={vi.fn()} />)
    const parentSelect = screen.getByLabelText('上级文件夹') as HTMLSelectElement
    const parentOptions = Array.from(parentSelect.options).map(o => o.textContent)
    expect(parentOptions).toEqual(['顶层', '工艺验证'])

    fireEvent.change(screen.getByLabelText('操作'), { target: { value: 'delete' } })
    expect(screen.getByText(/此文件夹关联 17 篇论文/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '执行文件夹操作' })).toBeDisabled()
  })

  it('FE-02: PaperDeleteDialog mounts inside fixed .kso-dialog-layer rather than .kso-overlay', async () => {
    vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue({
      planId: 'p1',
      path: 'sources/a.md',
      title: 'Doc A',
      expiresAt: '2030-01-01T00:00:00Z',
      pages: [],
      sharedCount: 0,
      unverifiedCount: 0,
    })
    const paper: SourcePaper = { id: 'sources/a.md', title: 'Doc A', folderIds: [], saved: true, indexStatus: 'ready' }
    const { container } = render(
      <PaperDeleteDialog paper={paper} folders={[]} storageKey="u1" onClose={vi.fn()} onDeleted={vi.fn()} />,
    )
    await screen.findByRole('button', { name: '确认删除文件' })
    expect(container.querySelector('.kso-dialog-layer')).not.toBeNull()
    expect(container.querySelector('.kso-overlay')).toBeNull()
  })

  it('FE-03: decodeKnowledgeV3 preserves underscore keys in folderCounts and reading maps', () => {
    const decoded = decodeKnowledgeV3<{ folderCounts: Record<string, number>; reading: Record<string, { updatedAt: string }> }>({
      folder_counts: { folder_alpha: 12, 'uuid-1': 5 },
      reading: { 'sources/my_paper.md': { updated_at: '2026-11-22T00:00:00Z' } },
    })
    expect(decoded.folderCounts).toEqual({ folder_alpha: 12, 'uuid-1': 5 })
    expect(decoded.reading['sources/my_paper.md'].updatedAt).toBe('2026-11-22T00:00:00Z')
  })

  it('FE-05: knowledgeV3Download decodes JSON Blob error payloads for sourceError', async () => {
    const blob = new Blob([JSON.stringify({ detail: '资料包超过100MB，请减少选择后分批导出' })], { type: 'application/json' })
    const axiosErr = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 413,
      statusText: 'Payload Too Large',
      headers: {},
      config: {} as never,
      data: blob,
    })
    vi.spyOn(axios.Axios.prototype, 'request').mockRejectedValue(axiosErr)
    await expect(knowledgeV3Download('/library/export', { paperIds: ['a'], format: 'zip' }, 'out.zip')).rejects.toThrow()
    expect(sourceError(axiosErr)).toBe('资料包超过100MB，请减少选择后分批导出')
  })

  it('FE-06: ManualIndexPanel survives transient poll errors and calls onChanged on completion', async () => {
    const onChanged = vi.fn()
    const getSpy = vi.spyOn(v3Api, 'knowledgeV3Get')
      .mockResolvedValueOnce({
        jobId: 'j1',
        status: 'running',
        indexStatus: 'pending',
        globalIncremental: true,
        originalSaved: true,
      })
      .mockRejectedValueOnce(new Error('transient network blip'))
      .mockResolvedValueOnce({
        jobId: 'j1',
        status: 'completed',
        indexStatus: 'ready',
        globalIncremental: true,
        originalSaved: true,
      })

    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<ManualIndexPanel paperId="archive:abc" canManage={true} indexStatus="pending" onChanged={onChanged} />)
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(5100)
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(5100)
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('SEC-07: safeExternalHref rejects javascript/data schemes and allows http/https and safe relative paths', () => {
    expect(safeExternalHref('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeExternalHref('//evil.example.com')).toBeUndefined()
    expect(safeExternalHref('/notes/123')).toBe('/notes/123')
    expect(safeExternalHref('https://www.ich.org/page/quality-guidelines')).toBe('https://www.ich.org/page/quality-guidelines')
  })
})
