import { useCallback, useEffect, useRef, useState } from 'react'
import { knowledgeLaunchUrl } from '../../lib/site'
import type { NotesClient, NoteSource, PersonalNote } from './client'

export function useNoteCollection(client: NotesClient, acceptParentRefresh = false) {
  const [query, setQuery] = useState({ search: '', source: '' as NoteSource | '', trashed: false, offset: 0 })
  const [result, setResult] = useState<{ client: NotesClient; items: PersonalNote[]; total: number }>({ client, items: [], total: 0 })
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [undoEntry, setUndo] = useState<{ client: NotesClient; note: PersonalNote } | null>(null)
  const [deniedClient, setDeniedClient] = useState<NotesClient | null>(null)
  const request = useRef(0), currentClient = useRef(client), pending = useRef(false)
  const embedState = useRef<'ready' | 'unavailable' | null>(null)
  const [embedIdentity] = useState(() => window.location.hash.slice(1))
  const reportEmbedState = useCallback((state: 'ready' | 'unavailable' | null) => {
    embedState.current = state
    if (!acceptParentRefresh || window.parent === window || !state || !/^[a-f0-9]{64}$/.test(embedIdentity)) return
    window.parent.postMessage({ type: `mberp:notes:${state}`, version: 1, identity: embedIdentity }, new URL(knowledgeLaunchUrl).origin)
  }, [acceptParentRefresh, embedIdentity])
  const refresh = useCallback(() => { setQuery(value => ({ ...value, offset: 0 })); setReload(value => value + 1) }, [])
  useEffect(() => {
    const token = ++request.current
    let active = true
    if (currentClient.current !== client) embedState.current = null
    currentClient.current = client
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      client.list({ search: query.search, sourceApp: query.source || undefined, trashed: query.trashed, offset: query.offset }).then(next => {
        if (!active || request.current !== token) return
        setResult(previous => ({ client, total: next.total, items: query.offset && previous.client === client ? [...previous.items, ...next.items.filter(note => !previous.items.some(old => old.id === note.id))] : next.items }))
        setDeniedClient(null)
        reportEmbedState('ready')
      }).catch(reason => {
        if (!active || request.current !== token) return
        setError(reason instanceof Error ? reason.message : '笔记读取失败，请重试。')
        if (reason?.status === 401 || reason?.status === 403) { setResult({ client, items: [], total: 0 }); setDeniedClient(client) }
        if (embedState.current !== 'ready' || reason?.status === 401 || reason?.status === 403) reportEmbedState('unavailable')
      }).finally(() => { if (active && request.current === token) setLoading(false) })
    }, query.search ? 200 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [client, query, reload, reportEmbedState])
  useEffect(() => {
    if (!acceptParentRefresh || window.parent === window) return
    const handler = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== new URL(knowledgeLaunchUrl).origin) return
      if (event.data?.type === 'mberp:notes:refresh') refresh()
      if (event.data?.type === 'mberp:notes:status' && event.data?.version === 1) reportEmbedState(embedState.current)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [acceptParentRefresh, refresh, reportEmbedState])
  useEffect(() => {
    const update = () => { if (document.visibilityState !== 'hidden') refresh() }
    const timer = window.setInterval(update, 15000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update) }
  }, [refresh])
  function filter(patch: Partial<typeof query>) {
    request.current++
    setResult({ client, items: [], total: 0 }); setLoading(true)
    setQuery(value => ({ ...value, ...patch, offset: 0 }))
  }
  async function move(note: PersonalNote, restore: boolean) {
    if (pending.current) return
    const owner = client
    pending.current = true; setBusy(true); setError('')
    try {
      const saved = restore ? await client.restore(note) : await client.trash(note)
      if (owner !== currentClient.current) return
      setUndo(restore ? null : { client, note: saved })
      setResult(previous => ({ ...previous, items: previous.items.filter(item => item.id !== note.id), total: Math.max(0, previous.total - 1) }))
      setNotice(restore ? '笔记已恢复。' : '笔记已移至回收站。'); refresh()
      return saved
    } catch (reason) { if (owner === currentClient.current) setError(reason instanceof Error ? reason.message : '操作未完成，请重试。') }
    finally { pending.current = false; setBusy(false) }
  }
  async function share(note: PersonalNote) {
    if (!client.share || pending.current) return
    const enabled = !note.wisdom?.enabled
    if (enabled && !window.confirm('共享后，知识库成员可以在检索和 AI 问答中使用这条笔记。是否继续？')) return
    const owner = client
    pending.current = true; setBusy(true); setError('')
    try {
      const saved = await client.share(note, enabled)
      if (owner !== currentClient.current) return
      setResult(previous => ({ ...previous, items: previous.items.map(item => item.id === saved.id ? saved : item) }))
      setNotice(enabled ? '已安排共享到知识库检索。' : '已安排撤下检索副本。'); refresh()
    } catch (reason) { if (owner === currentClient.current) setError(reason instanceof Error ? reason.message : '共享操作未完成。') }
    finally { pending.current = false; setBusy(false) }
  }
  return {
    ...query, items: result.client === client ? result.items : [], total: result.client === client ? result.total : 0,
    loading, error, notice, busy, undo: undoEntry?.client === client ? undoEntry.note : null, accessLost: deniedClient === client, refresh, filter, move, share, setNotice,
    loadMore: () => setQuery(value => ({ ...value, offset: result.items.length })),
  }
}
