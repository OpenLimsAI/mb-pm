import { useEffect, useState } from 'react'
import { Bell, RefreshCw } from 'lucide-react'
import { feedbackClient, formatDate, type FeedbackNotifications as NotificationResponse } from './shared'

type Props = { preview: boolean; onOpen: (id: string) => void; onError: (error: unknown) => string; onCount: (count: number) => void }
export default function FeedbackNotifications({ preview, onOpen, onError, onCount }: Props) {
  const [data, setData] = useState<NotificationResponse>({ items: [], unread_count: 0 })
  const [unreadOnly, setUnreadOnly] = useState(true)
  const [loading, setLoading] = useState(!preview)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (preview) return
    let active = true
    feedbackClient.get<NotificationResponse>('/notifications', { params: { unread_only: unreadOnly } }).then(({ data }) => { if (active) { setData(data); onCount(data.unread_count) } }).catch(err => { if (active) setError(onError(err)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [preview, unreadOnly, reload, onError, onCount])
  const refresh = () => { setError(''); setLoading(true); setReload(value => value + 1) }
  const mark = async (id?: string, feedbackId?: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (!preview) {
        const result = await feedbackClient.post<NotificationResponse>('/notifications/read', id ? { ids: [id] } : { all: true })
        setData(result.data); onCount(result.data.unread_count)
      } else {
        setData(current => ({ ...current, unread_count: id ? Math.max(0, current.unread_count - (current.items.find(x => x.id === id)?.read_at ? 0 : 1)) : 0, items: current.items.map(x => !id || x.id === id ? { ...x, read_at: new Date().toISOString() } : x) }))
      }
      if (feedbackId) onOpen(feedbackId)
      else refresh()
    } catch (err) { setError(onError(err)); if (feedbackId) onOpen(feedbackId) }
    finally { setBusy(false) }
  }
  const visible = data.items.filter(item => !unreadOnly || !item.read_at)
  return <section className="feedback-board feedback-notifications" aria-label="通知中心"><div className="feedback-board-heading"><div><h2>通知中心 <span>{data.unread_count} 条未读</span></h2><p>回复、分派、发布与验证结果会在这里提醒你。</p></div><button type="button" className="feedback-outline-button" disabled={busy || loading || !data.unread_count} onClick={() => void mark()}>全部标为已读</button></div><div className="feedback-notification-toolbar"><div className="feedback-scopes" role="group" aria-label="通知筛选"><button type="button" aria-pressed={unreadOnly} onClick={() => { if (!unreadOnly) { setUnreadOnly(true); setLoading(!preview); setError('') } }}>未读通知</button><button type="button" aria-pressed={!unreadOnly} onClick={() => { if (unreadOnly) { setUnreadOnly(false); setLoading(!preview); setError('') } }}>全部通知</button></div><button type="button" className="feedback-outline-button" disabled={loading || preview} onClick={refresh}><RefreshCw size={15} />刷新通知</button></div>
    {error && <p className="feedback-history-error" role="alert">{error}</p>}{loading ? <div className="feedback-empty">正在加载通知…</div> : visible.length ? <div className="feedback-notification-items">{visible.map(item => <button type="button" key={item.id} disabled={busy} className={`feedback-notification ${item.read_at ? 'is-read' : ''}`} onClick={() => void mark(item.id, item.feedback_id)}><Bell size={18} /><div><strong>{item.number || '反馈更新'}</strong><p>{item.body}</p><time dateTime={item.created_at}>{formatDate(item.created_at)}</time></div>{!item.read_at && <span className="feedback-unread-dot" aria-label="未读" />}</button>)}</div> : !error && <div className="feedback-empty">{unreadOnly ? '暂无未读通知。' : '暂无通知。'}</div>}
  </section>
}
