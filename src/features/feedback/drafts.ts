/** Local-only, identity-scoped drafts. Attachments never leave the browser here. */
export type SavedDraft<T> = { value: T; files: File[]; savedAt: string }
type StoredDraft = SavedDraft<unknown> & { id: string }
const databaseName = 'maibo-feedback-drafts-v1'
const storeName = 'drafts'
const maxAge = 14 * 24 * 60 * 60 * 1000
const queues = new Map<string, Promise<unknown>>()
const draftId = (namespace: string, key: string) => `${encodeURIComponent(namespace)}:${encodeURIComponent(key)}`
const fallbackKey = (id: string) => `${databaseName}:${id}`
const deletedKey = (id: string) => `${databaseName}:deleted:${id}`
function deletedAt(id: string) { try { return Number(localStorage.getItem(deletedKey(id))) || 0 } catch { return 0 } }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(storeName, { keyPath: 'id' }) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Draft storage blocked'))
  })
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode)
      const request = action(transaction.objectStore(storeName))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || new Error('Draft transaction aborted'))
    })
  } finally { db.close() }
}

function enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const task = (queues.get(id) || Promise.resolve()).catch(() => undefined).then(operation)
  queues.set(id, task)
  void task.finally(() => { if (queues.get(id) === task) queues.delete(id) }).catch(() => undefined)
  return task
}

function fresh(value: unknown, id: string): value is StoredDraft {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StoredDraft>
  const age = Date.now() - Date.parse(item.savedAt || '')
  return item.id === id && Object.hasOwn(item, 'value') && Number.isFinite(age) && age >= -60_000 && age < maxAge
}

export async function loadDraft<T>(namespace: string | undefined, key: string): Promise<SavedDraft<T> | null> {
  if (!namespace) return null
  const id = draftId(namespace, key)
  return enqueue(id, async () => {
    let stored: unknown
    let fallback: unknown
    try { stored = await transact<StoredDraft | undefined>('readonly', store => store.get(id)) } catch { /* Text fallback below. */ }
    try { fallback = JSON.parse(localStorage.getItem(fallbackKey(id)) || 'null') } catch { /* Storage may be disabled. */ }
    const tombstone = deletedAt(id)
    const candidates = [stored, fallback].filter(value => fresh(value, id)).filter(value => Date.parse(value.savedAt) > tombstone).sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    const newest = candidates[0]
    if (!newest) return null
    const files = Array.isArray(newest.files) ? newest.files.filter(file => file instanceof File && file.size <= 5 * 1024 * 1024 && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)).slice(0, 3) : []
    return { value: newest.value as T, files, savedAt: newest.savedAt }
  })
}

/** False means the full draft (including images) could not be saved. */
export async function saveDraft<T>(namespace: string | undefined, key: string, value: T, files: File[] = []): Promise<boolean> {
  if (!namespace) return false
  const id = draftId(namespace, key)
  return enqueue(id, async () => {
    const item: StoredDraft = { id, value, files, savedAt: new Date(Math.max(Date.now(), deletedAt(id) + 1)).toISOString() }
    if (files.length > 3 || files.some(file => file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return false
    try {
      await transact('readwrite', store => store.put(item))
      try { localStorage.removeItem(fallbackKey(id)) } catch { /* Best effort. */ }
      return true
    } catch {
      try {
        localStorage.setItem(fallbackKey(id), JSON.stringify({ ...item, files: [] }))
        return files.length === 0
      } catch { return false }
    }
  })
}

export async function deleteDraft(namespace: string | undefined, key: string): Promise<void> {
  if (!namespace) return
  const id = draftId(namespace, key)
  await enqueue(id, async () => {
    // A temporary IndexedDB failure must not resurrect a submitted/discarded draft.
    try { localStorage.setItem(deletedKey(id), String(Date.now())) } catch { /* IDB deletion still works. */ }
    try { await transact('readwrite', store => store.delete(id)) } catch { /* Disabled storage. */ }
    try { localStorage.removeItem(fallbackKey(id)) } catch { /* Disabled storage. */ }
  })
}
