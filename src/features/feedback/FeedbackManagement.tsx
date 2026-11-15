import { useRef, useState } from 'react'
import { AlertCircle, Check, CircleDot, RefreshCw } from 'lucide-react'
import { feedbackClient, normalizeFeedbackStatus, statusLabels, type FeedbackActivity, type FeedbackItem, type FeedbackPriority } from './shared'

// Kept only to recover text from drafts created before the simpler feedback flow.
export type ManagementDraft = { changes: { assignee_id?: string | null; priority?: FeedbackPriority; due_at?: string | null }; resolution: string | null; verification: string | null; version: string | null; note: string }
type Props = {
  item: FeedbackItem
  preview: boolean
  userName: string
  disabled?: boolean
  onUpdated: (item: FeedbackItem) => void
  onActivity: (activity: FeedbackActivity) => void
  onError: (error: unknown) => string
  onBusyChange?: (busy: boolean) => void
}

export default function FeedbackManagement({ item, preview, userName, disabled = false, onUpdated, onActivity, onError, onBusyChange }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const currentStatus = normalizeFeedbackStatus(item.status)
  const targetStatus = currentStatus === 'fixed' ? 'open' : 'fixed'
  const updateStatus = async () => {
    if (lock.current || disabled || item.can_update_status === false) return
    lock.current = true; setBusy(true); onBusyChange?.(true); setError(''); setNotice('')
    try {
      if (preview) {
        const createdAt = new Date().toISOString()
        onUpdated({ ...item, status: targetStatus, last_activity_at: createdAt })
        onActivity({ id: crypto.randomUUID(), kind: 'status', body: '', author_name: userName, created_at: createdAt, from_status: item.status, to_status: targetStatus })
      } else {
        onUpdated((await feedbackClient.patch<FeedbackItem>(`/${item.id}`, { status: targetStatus })).data)
        try {
          const page = await feedbackClient.get<{ items: FeedbackActivity[] }>(`/${item.id}/activities`)
          page.data.items.forEach(onActivity)
        } catch {
          setNotice('状态已更新，回复记录暂未刷新，可点击刷新重试。')
          return
        }
      }
      setNotice(targetStatus === 'fixed' ? '已标记为已修复。' : '已重新打开。')
    } catch (err) { setError(onError(err)) }
    finally { lock.current = false; setBusy(false); onBusyChange?.(false) }
  }
  return <section className="feedback-management feedback-simple-status" aria-label="反馈处理状态">
    <div><h3>处理状态</h3><span className={`feedback-status feedback-status--${currentStatus}`}>{statusLabels[currentStatus]}</span></div>
    {item.can_update_status !== false && <button className={targetStatus === 'fixed' ? 'feedback-create' : 'feedback-outline-button'} type="button" disabled={busy || disabled} onClick={() => void updateStatus()}>
      {busy ? <RefreshCw size={16} className="feedback-spin" /> : targetStatus === 'fixed' ? <Check size={16} /> : <CircleDot size={16} />}
      {busy ? '正在保存…' : targetStatus === 'fixed' ? '标记已修复' : '重新打开'}
    </button>}
    {error && <p className="feedback-history-error" role="alert"><AlertCircle size={14} />{error}</p>}
    {notice && <p className="feedback-discussion-notice" role="status">{notice}</p>}
  </section>
}
