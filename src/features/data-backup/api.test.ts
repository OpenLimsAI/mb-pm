import { afterEach, expect, it, vi } from 'vitest'
import { accessLost, backupApi, BackupApiError, previewSnapshot } from './api'
afterEach(() => vi.unstubAllGlobals())
it('pins the expected subject and never follows an authentication redirect', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(previewSnapshot), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  await backupApi.snapshot('subject-a', new AbortController().signal)
  expect(fetcher).toHaveBeenCalledWith('/api/v1/data-backup/snapshot', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: expect.objectContaining({ 'X-Backup-Expected-Identity': 'subject-a' }) }))
})
it('preserves an actionable backend reason and recognizes identity change independently of catalog conflict', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { code: 'backup_identity_changed', message: '账号已经切换，请重新加载。' } }), { status: 409 })))
  const error = await backupApi.snapshot('subject-a', new AbortController().signal).catch(value => value)
  expect(error).toBeInstanceOf(BackupApiError)
  expect(error.message).toBe('账号已经切换，请重新加载。')
  expect(accessLost(error)).toBe(true)
  expect(accessLost(new BackupApiError(409, '目录已更新', 'revision_conflict'))).toBe(false)
})
it('rejects incomplete successful snapshots instead of inventing a plan or metrics', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  await expect(backupApi.snapshot('a', new AbortController().signal)).rejects.toThrow('备份状态不完整')
})
it('sends only selected identifiers and revision to deletion preview and rejects unexpected extra files', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'token', itemCount: 2, items: [{ id: 'a' }, { id: 'b' }], expiresAt: new Date(Date.now() + 300000).toISOString() }), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(backupApi.previewDeletion('admin', ['a'], 'revision-a', new AbortController().signal)).rejects.toThrow('删除预览与所选文件不一致')
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/data-backup/delete-preview')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ archiveIds: ['a'], catalogRevision: 'revision-a' })
})
it('sends token confirmation and idempotency key to selected deletion only', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'receipt', status: 'succeeded', deletedCount: 1, deletedBytes: 42, actor: 'a', createdAt: '' }), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  const body = { token: 'token', confirmation: '删除 1 份备份', requestId: 'request-1' }
  await backupApi.deleteArchives('a', body, new AbortController().signal)
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/data-backup/deletions')
  expect(fetcher.mock.calls[0][1].method).toBe('POST')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body)
  expect(Object.keys(backupApi)).toEqual(['snapshot', 'previewDeletion', 'deleteArchives'])
})
