// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deleteDraft, loadDraft, saveDraft } from './drafts'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('localStorage', new MemoryStorage())
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('restores text and screenshot bytes after the module is reloaded', async () => {
  const file = new File(['PNG screenshot contents'], 'screen.png', { type: 'image/png' })
  expect(await saveDraft('issuer-person-A', 'compose', { application: 'kb', description: '未提交的反馈' }, [file])).toBe(true)
  vi.resetModules()
  const restored = await (await import('./drafts')).loadDraft<{ application: string; description: string }>('issuer-person-A', 'compose')
  expect(restored?.value).toEqual({ application: 'kb', description: '未提交的反馈' })
  expect(restored?.files).toHaveLength(1)
  expect(restored?.files[0]).toBeInstanceOf(File)
  expect(restored?.files[0].name).toBe('screen.png')
  expect(await restored?.files[0].text()).toBe('PNG screenshot contents')
})

it('isolates accounts and individual reply drafts even when one identifier contains separators', async () => {
  await saveDraft('issuer:A/person', 'compose', { body: 'A的草稿' })
  await saveDraft('issuer:A/person', 'reply:issue-1', { body: '问题一回复' })
  await saveDraft('issuer:A/person', 'reply:issue-2', { body: '问题二回复' })
  expect(await loadDraft('issuer:B/person', 'compose')).toBeNull()
  expect(await loadDraft('issuer:A', 'person:compose')).toBeNull()
  expect((await loadDraft<{ body: string }>('issuer:A/person', 'reply:issue-1'))?.value.body).toBe('问题一回复')
  await deleteDraft('issuer:A/person', 'reply:issue-1')
  expect(await loadDraft('issuer:A/person', 'reply:issue-1')).toBeNull()
  expect((await loadDraft<{ body: string }>('issuer:A/person', 'reply:issue-2'))?.value.body).toBe('问题二回复')
  expect((await loadDraft<{ body: string }>('issuer:A/person', 'compose'))?.value.body).toBe('A的草稿')
})

it('does not read or save browser data before an identity namespace is known', async () => {
  const open = vi.spyOn(indexedDB, 'open')
  expect(await saveDraft(undefined, 'compose', { body: 'anonymous' })).toBe(false)
  expect(await loadDraft(undefined, 'compose')).toBeNull()
  await deleteDraft(undefined, 'compose')
  expect(open).not.toHaveBeenCalled()
  expect(localStorage.length).toBe(0)
})

it('orders queued autosaves and discard so an earlier write cannot resurrect the draft', async () => {
  await Promise.all([
    saveDraft('person', 'compose', { body: 'early' }),
    saveDraft('person', 'compose', { body: 'later' }),
    deleteDraft('person', 'compose'),
  ])
  expect(await loadDraft('person', 'compose')).toBeNull()
})

it('ignores expired drafts rather than restoring old private text', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
  await saveDraft('person', 'compose', { body: 'expired' })
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'))
  expect(await loadDraft('person', 'compose')).toBeNull()
})

it('reports incomplete image persistence when IndexedDB fails and still recovers text', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const screenshot = new File(['image'], 'screen.png', { type: 'image/png' })
  expect(await saveDraft('person', 'compose', { body: '文字已保留' }, [screenshot])).toBe(false)
  const recovered = await loadDraft<{ body: string }>('person', 'compose')
  expect(recovered?.value.body).toBe('文字已保留')
  expect(recovered?.files).toEqual([])
  expect(await saveDraft('person', 'reply:issue', { body: '仅文字' })).toBe(true)
})

it('does not revive a discarded IndexedDB copy after a temporary storage outage', async () => {
  const database = indexedDB
  await saveDraft('person', 'compose', { body: '已经放弃' })
  vi.stubGlobal('indexedDB', undefined)
  await deleteDraft('person', 'compose')
  vi.stubGlobal('indexedDB', database)
  expect(await loadDraft('person', 'compose')).toBeNull()
})

it('can create a new draft immediately after discarding one in the same millisecond', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'))
  await saveDraft('person', 'compose', { body: 'old' })
  await deleteDraft('person', 'compose')
  expect(await saveDraft('person', 'compose', { body: 'new' })).toBe(true)
  expect((await loadDraft<{ body: string }>('person', 'compose'))?.value.body).toBe('new')
})

it('keeps the last valid image draft when a later autosave exceeds the upload contract', async () => {
  const file = new File(['good'], 'screen.png', { type: 'image/png' })
  await saveDraft('person', 'compose', { body: 'valid' }, [file])
  const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
  expect(await saveDraft('person', 'compose', { body: 'oversize' }, [oversized])).toBe(false)
  expect(await saveDraft('person', 'compose', { body: 'too many' }, [file, file, file, file])).toBe(false)
  expect(await saveDraft('person', 'compose', { body: 'wrong type' }, [new File(['gif'], 'a.gif', { type: 'image/gif' })])).toBe(false)
  const restored = await loadDraft<{ body: string }>('person', 'compose')
  expect(restored?.value.body).toBe('valid')
  expect(restored?.files).toHaveLength(1)
})

it('fails closed when both storage mechanisms are unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)
  vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } })
  expect(await saveDraft('person', 'compose', { body: 'not saved' })).toBe(false)
  expect(await loadDraft('person', 'compose')).toBeNull()
  await expect(deleteDraft('person', 'compose')).resolves.toBeUndefined()
})
