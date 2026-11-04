import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { projects, tasks, subProjects, users } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { filterProjects, filterTasks, getScope } from '../../lib/scope'
import { taskLink } from '../../lib/taskLink'

export function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const user = useAuth(s => s.currentUser)
  useDataStore(s => s.version)
  const scope = getScope(user)
  const key = query.trim().toLocaleLowerCase()
  const owner = (id: string) => users.find(u => u.id === id)?.displayName || ''
  const matchingProjects = key ? filterProjects(projects, scope).filter(p => `${p.code} ${p.name} ${p.description || ''} ${owner(p.ownerId)}`.toLocaleLowerCase().includes(key)) : []
  const matchingTasks = key ? filterTasks(tasks, scope).filter(t => `${t.code} ${t.name} ${owner(t.ownerId)} ${t.notes || ''}`.toLocaleLowerCase().includes(key)) : []
  return <form role="search" className="app-search flex-1 max-w-sm relative" onSubmit={e => {
    e.preventDefault(); setOpen(false)
    navigate(matchingTasks.length && !matchingProjects.length ? taskLink(matchingTasks[0], subProjects) : `/projects?q=${encodeURIComponent(query.trim())}`)
  }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
    <Search className="w-4 h-4 absolute left-3 top-2 text-ink-500 pointer-events-none" />
    <input className="input !pl-9 !py-1.5" aria-label="搜索项目、任务、里程碑或负责人" placeholder="搜索项目、任务、负责人…" value={query} onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setOpen(true) }} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }} />
    {open && key && <div className="absolute z-50 top-full mt-1 w-[min(36rem,85vw)] max-h-96 overflow-auto bg-white border shadow-xl rounded-lg p-2" aria-label="搜索结果">
      <p className="text-xs text-ink-500 px-2 py-1">项目 {matchingProjects.length} · 任务 / 里程碑 {matchingTasks.length}</p>
      {matchingProjects.slice(0, 8).map(p => <Link key={p.id} to={`/projects/${p.id}`} onClick={() => setOpen(false)} className="block p-2 hover:bg-brand-50 rounded text-sm">项目 · {p.name}<span className="block text-xs text-ink-500">{p.code} · {owner(p.ownerId)}</span></Link>)}
      {matchingTasks.slice(0, 16).map(t => <Link key={t.id} to={taskLink(t, subProjects)} onClick={() => setOpen(false)} className="block p-2 hover:bg-brand-50 rounded text-sm">{t.isMilestone ? '里程碑' : '任务'} · {t.name}<span className="block text-xs text-ink-500">{t.code} · {owner(t.ownerId)}</span></Link>)}
      {!matchingProjects.length && !matchingTasks.length && <p className="p-3 text-sm text-ink-500">没有匹配的项目或任务</p>}
      {matchingTasks.length > 16 && <Link to={`/tasks?q=${encodeURIComponent(query.trim())}`} className="block p-2 text-brand-700 text-sm" onClick={() => setOpen(false)}>查看全部任务结果</Link>}
    </div>}
  </form>
}
