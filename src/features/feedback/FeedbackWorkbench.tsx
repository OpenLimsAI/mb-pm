import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { applicationLabel, feedbackClient, formatDate, issueLabel, priorityLabels, statusLabels, type FeedbackItem, type FeedbackWorkbench } from './shared'

type Props = { preview: boolean; previewItems: FeedbackItem[]; userId: string; onOpen: (item: FeedbackItem) => void; onError: (error: unknown) => string }
export default function FeedbackWorkbench({ preview, previewItems, userId, onOpen, onError }: Props) {
  const [data, setData] = useState<FeedbackWorkbench | null>(null)
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(!preview)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (preview) return
    let active = true
    feedbackClient.get<FeedbackWorkbench>('/workbench').then(response => { if (active) setData(response.data) }).catch(err => { if (active) setError(onError(err)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [preview, reload, onError])
  const result = preview ? { items: previewItems, metrics: { open: previewItems.filter(x => x.status === 'open').length, in_progress: previewItems.filter(x => x.status === 'in_progress').length, ready: previewItems.filter(x => x.status === 'ready').length, released: previewItems.filter(x => x.status === 'released').length, fixed: previewItems.filter(x => x.status === 'fixed').length, overdue: previewItems.filter(x => x.is_overdue).length, unassigned: previewItems.filter(x => !x.assignee_id).length, mine: previewItems.filter(x => x.assignee_id === userId).length, average_resolution_hours: null } } as FeedbackWorkbench : data
  const visible = (result?.items || []).filter(item => filter === 'mine' ? item.status !== 'fixed' && item.assignee_id === userId : filter === 'unassigned' ? item.status !== 'fixed' && !item.assignee_id : filter === 'overdue' ? item.is_overdue : filter === 'verification' ? item.status === 'released' : filter === 'unanswered' ? !item.reply_count && item.status !== 'fixed' : true)
  const refresh = () => { setLoading(true); setError(''); setReload(value => value + 1) }
  return <section className="feedback-board feedback-workbench" aria-label="处理工作台">
    <div className="feedback-board-heading"><div><h2>处理工作台</h2><p>按负责人、计划日期和交付阶段跟进，统计来自当前反馈记录。</p></div><button type="button" className="feedback-outline-button" disabled={loading || preview} onClick={refresh}><RefreshCw size={15} />刷新工作台</button></div>
    {loading ? <p className="feedback-empty">正在加载处理工作台…</p> : error ? <div className="feedback-empty" role="alert"><p>{error}</p><button type="button" className="feedback-outline-button" onClick={refresh}>重新加载工作台</button></div> : result && <>
      <div className="feedback-workbench-metrics">{(['open', 'in_progress', 'ready', 'released', 'fixed'] as const).map(status => <div key={status}><strong>{result.metrics[status]}</strong><span>{statusLabels[status]}</span></div>)}<div><strong>{result.metrics.overdue}</strong><span>已逾期</span></div><div><strong>{result.metrics.average_resolution_hours == null ? '—' : `${Math.round(result.metrics.average_resolution_hours * 10) / 10} 小时`}</strong><span>平均解决用时</span></div></div>
      {result.by_application && <div className="feedback-application-metrics"><h3>按应用响应与解决情况</h3><table><thead><tr><th>应用</th><th>反馈数</th><th>未解决</th><th>逾期</th><th>平均首响</th><th>平均解决用时</th></tr></thead><tbody>{result.by_application.map(row => <tr key={row.application || 'unclassified'}><td>{applicationLabel(row.application)}</td><td>{row.total}</td><td>{row.pending}</td><td>{row.overdue}</td><td>{row.average_first_response_hours == null ? '—' : `${Math.round(row.average_first_response_hours * 10) / 10} 小时（${row.first_response_count} 条）`}</td><td>{row.average_resolution_hours == null ? '—' : `${Math.round(row.average_resolution_hours * 10) / 10} 小时（${row.resolution_count} 条）`}</td></tr>)}</tbody></table><p className="feedback-field-help">仅统计有真实首响或解决记录的反馈；历史记录缺少时间时不推算。</p></div>}
      <div className="feedback-scopes feedback-workbench-scopes" role="group" aria-label="工作台筛选">{[['all', '全部事项'], ['mine', '我的负责'], ['unassigned', '待分配'], ['unanswered', '未回复'], ['overdue', '已逾期'], ['verification', '待验证']].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}{value === 'mine' ? ` ${result.metrics.mine}` : value === 'unassigned' ? ` ${result.metrics.unassigned}` : ''}</button>)}</div>
      {visible.length ? <div className="feedback-workbench-items">{visible.map(item => <button type="button" key={item.id} className="feedback-workbench-item" onClick={() => onOpen(item)}><div><span className="feedback-issue-number">{issueLabel(item)}</span><span className={`feedback-status feedback-status--${item.status}`}>{statusLabels[item.status]}</span><span className="feedback-application-tag">{applicationLabel(item.application)}</span><span>{priorityLabels[item.priority || 'p2']}</span></div><strong>{item.description.slice(0, 180)}</strong><small>负责人：{item.assignee_name || '待分配'}{item.due_at ? ` · 计划完成 ${formatDate(item.due_at)}` : ''}{item.is_overdue ? ' · 已逾期' : ''} · {item.reply_count ?? 0} 条回复</small></button>)}</div> : <div className="feedback-empty">当前筛选下没有事项。</div>}
    </>}
  </section>
}
