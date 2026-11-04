import { FileText, LoaderCircle, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { TaskSummary } from './client'

interface Props {
  tasks: TaskSummary[]
  total: number
  search: string
  loading: boolean
  error: string
  busy: boolean
  onSearch: (value: string) => void
  onRefresh: () => void
  onMore: () => void
  onView: (task: TaskSummary) => void
  onRestore: (task: TaskSummary) => void
}

export default function TrashView({ tasks, total, search, loading, error, busy, onSearch, onRefresh, onMore, onView, onRestore }: Props) {
  return <section className="aa-trash-view" aria-label="已删除任务列表" aria-busy={loading}>
    <div className="aa-trash-intro"><div><h3>已删除任务</h3><p>查看保留的对话与产物，或将任务恢复到任务列表。</p></div><button className="aa-button" type="button" aria-label="刷新回收站" disabled={loading} onClick={onRefresh}><RefreshCw size={14} />刷新</button></div>
    <label className="aa-search aa-trash-search"><Search size={16} /><input aria-label="搜索回收站" placeholder="搜索已删除任务和对话" value={search} maxLength={200} onChange={event => onSearch(event.target.value)} /></label>
    {error ? <div className="aa-trash-state aa-trash-error" role="alert"><h3>回收站暂时无法读取</h3><p>{error}</p><button className="aa-button" type="button" onClick={onRefresh}>重试</button></div> : <>
      {loading && <div className="aa-loading" role="status"><LoaderCircle size={16} className="aa-spin" />正在读取回收站…</div>}
      {tasks.length > 0 && <ul className="aa-trash-list">{tasks.map(item => <li key={item.id} className="aa-trash-row"><FileText size={19} /><div className="aa-trash-row-info"><h3>{item.title}</h3><p>删除于 <time dateTime={item.deletedAt || undefined}>{item.deletedAt ? new Date(item.deletedAt).toLocaleString('zh-CN') : '时间未记录'}</time></p>{item.excerpt && <small className="aa-search-excerpt">{item.excerpt}</small>}</div><div className="aa-trash-row-actions"><button className="aa-button" type="button" aria-label={`查看已删除任务：${item.title}`} onClick={() => onView(item)}>查看</button><button className="aa-button" type="button" aria-label={`恢复任务：${item.title}`} disabled={busy} onClick={() => onRestore(item)}><RotateCcw size={14} />恢复</button></div></li>)}</ul>}
      {!loading && !tasks.length && <div className="aa-trash-state"><Trash2 size={34} /><h3>{search.trim() ? '没有匹配的已删除任务' : '回收站为空'}</h3><p>{search.trim() ? '试试其他关键词，或清除搜索查看全部已删除任务。' : '删除的任务会显示在这里，可随时查看或恢复。'}</p>{search && <button className="aa-button" type="button" onClick={() => onSearch('')}>清除搜索</button>}</div>}
      {tasks.length < total && <button className="aa-button aa-trash-more" type="button" disabled={loading} onClick={onMore}>加载更多已删除任务</button>}
    </>}
  </section>
}
