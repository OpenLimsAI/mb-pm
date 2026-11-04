import { useEffect, useState } from 'react'
import { api, asAPIError } from '../../api/client'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'

interface View<T> { id: string; name: string; kind: string; state: T; revision: number }

export function SavedViews<T>({ kind, state, onApply }: { kind: 'projects' | 'tasks'; state: T; onApply: (state: T) => void }) {
  const userId = useAuth(s => s.currentUser?.id)
  const online = useDataStore(s => s.mode === 'api')
  const [views, setViews] = useState<View<T>[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    if (online) void api.get<View<T>[]>('/pm/views').then(r => { if (active) setViews(r.data.filter(v => v.kind === kind)) }).catch(e => { if (active) setError(asAPIError(e).detail) })
    return () => { active = false }
  }, [online, kind, userId])
  async function save() {
    setBusy(true); setError('')
    try {
      const existing = views.find(v => v.name === name.trim())
      const { data } = await api.put<View<T>>('/pm/views', { kind, name: name.trim(), state, revision: existing?.revision })
      setViews(current => [...current.filter(v => v.id !== data.id), data]); setName('')
    } catch (e) { setError(asAPIError(e).detail) } finally { setBusy(false) }
  }
  async function remove(id: string) {
    setBusy(true); setError('')
    try { await api.delete(`/pm/views/${encodeURIComponent(id)}`); setViews(v => v.filter(row => row.id !== id)) }
    catch (e) { setError(asAPIError(e).detail) } finally { setBusy(false) }
  }
  if (!online) return null
  return <div className="my-3 flex flex-wrap items-center gap-2 text-xs" aria-label="常用视图">
    <span className="text-ink-500">常用视图</span>
    {views.map(v => <span key={v.id} className="inline-flex border rounded-md overflow-hidden"><button type="button" className="px-2 py-1 hover:bg-brand-50" onClick={() => onApply(v.state)}>{v.name}</button><button type="button" disabled={busy} className="px-1 text-ink-500" aria-label={`删除视图 ${v.name}`} onClick={() => void remove(v.id)}>×</button></span>)}
    <input aria-label="视图名称" maxLength={80} className="input !w-36 !py-1" placeholder="新视图名称" value={name} onChange={e => setName(e.target.value)} />
    <button type="button" className="text-brand-700" disabled={!name.trim() || busy} onClick={() => void save()}>{views.some(v => v.name === name.trim()) ? '更新该视图' : '保存当前视图'}</button>
    {error && <span role="alert" className="text-red-700">{error}</span>}
  </div>
}
