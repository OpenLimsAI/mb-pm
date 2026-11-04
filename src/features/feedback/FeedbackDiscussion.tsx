import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AlertCircle, ArrowUpRight, CheckCircle2, MessageSquareText, RefreshCw, Send, X } from 'lucide-react'
import { feedbackClient, formatDate, imageUrl, mergeActivities, statusLabels, type ActivityPage, type FeedbackActivity, type FeedbackItem, type FeedbackStatus } from './shared'

type Props = {
  item: FeedbackItem
  initialStatus?: FeedbackStatus
  preview: boolean
  userName: string
  previewActivities: FeedbackActivity[]
  onPreviewActivity: (activity: FeedbackActivity) => void
  onUpdated: (item: FeedbackItem) => void
  onError: (error: unknown) => string
  onClose: () => void
}

export default function FeedbackDiscussion({ item, initialStatus, preview, userName, previewActivities, onPreviewActivity, onUpdated, onError, onClose }: Props) {
  const [activities, setActivities] = useState<FeedbackActivity[]>(() => preview ? previewActivities : [])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(!preview)
  const [loadError, setLoadError] = useState('')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState('')
  const [body, setBody] = useState('')
  const [statusChoice, setStatusChoice] = useState<FeedbackStatus | ''>(initialStatus ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const continueEditing = useRef<HTMLButtonElement>(null)
  const replyField = useRef<HTMLTextAreaElement>(null)
  const statusField = useRef<HTMLSelectElement>(null)
  const request = useRef<{ fingerprint: string; id: string; payload: { body: string; status?: FeedbackStatus } } | null>(null)
  const submitting = useRef(false)
  const loadedOlder = useRef(false)
  const wasConfirming = useRef(false)
  const mounted = useRef(true)
  const targetStatus = statusChoice && statusChoice !== item.status ? statusChoice : undefined
  const dirty = !!body.trim() || !!targetStatus
  const blocked = pending || loading || !!loadError || loadingOlder

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (preview) return
    let active = true
    feedbackClient.get<ActivityPage>(`/${item.id}/activities`).then(({ data }) => {
      if (active) { setActivities(data.items); setNextCursor(data.next_cursor); if (data.feedback) onUpdated(data.feedback) }
    }).catch((err: unknown) => { if (active) setLoadError(onError(err)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [item.id, preview, onError, onUpdated])
  useEffect(() => {
    if (confirmDiscard) continueEditing.current?.focus()
    else if (wasConfirming.current) replyField.current?.focus()
    else if (initialStatus) statusField.current?.focus()
    else title.current?.focus()
    wasConfirming.current = confirmDiscard
  }, [confirmDiscard, initialStatus])
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  const requestClose = () => {
    if (submitting.current) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }
  const handleKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (confirmDiscard) setConfirmDiscard(false)
      else requestClose()
    }
    if (event.key !== 'Tab') return
    const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]')
    if (!nodes?.length) { event.preventDefault(); return }
    const first = nodes[0], last = nodes[nodes.length - 1]
    if (!Array.from(nodes).includes(document.activeElement as HTMLElement)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const retry = async () => {
    setLoading(true); setLoadError(''); setOlderError('')
    try {
      const { data } = await feedbackClient.get<ActivityPage>(`/${item.id}/activities`)
      if (mounted.current) { loadedOlder.current = false; setActivities(data.items); setNextCursor(data.next_cursor); if (data.feedback) onUpdated(data.feedback) }
    } catch (err) { if (mounted.current) setLoadError(onError(err)) }
    finally { if (mounted.current) setLoading(false) }
  }
  const loadOlder = async () => {
    if (!nextCursor || loadingOlder) return
    setLoadingOlder(true); setOlderError('')
    try {
      const { data } = await feedbackClient.get<ActivityPage>(`/${item.id}/activities`, { params: { before: nextCursor } })
      if (mounted.current) { loadedOlder.current = true; setActivities(current => mergeActivities(current, data.items)); setNextCursor(data.next_cursor); if (data.feedback) onUpdated(data.feedback) }
    } catch (err) { if (mounted.current) setOlderError(onError(err)) }
    finally { if (mounted.current) setLoadingOlder(false) }
  }
  const save = async (reply: boolean) => {
    if (submitting.current || blocked) return
    const message = body.trim()
    if (reply && !message) { setError('请填写回复内容。'); replyField.current?.focus(); return }
    if (!reply && !targetStatus) return
    submitting.current = true; setPending(true); setError(''); setNotice('')
    try {
      if (preview) {
        const now = new Date().toISOString()
        const activity: FeedbackActivity = {
          id: crypto.randomUUID(), kind: targetStatus ? 'status' : 'comment', body: message,
          author_name: userName, created_at: now,
          from_status: targetStatus ? item.status : null, to_status: targetStatus ?? null,
        }
        const updated = { ...item, status: targetStatus ?? item.status, reply_count: (item.reply_count ?? 0) + (message ? 1 : 0), last_activity_at: now }
        onPreviewActivity(activity); setActivities(current => mergeActivities(current, [activity])); onUpdated(updated)
      } else if (reply || message) {
        // Reuse the same key after an ambiguous network failure; edited drafts get a new key.
        const fingerprint = JSON.stringify({ body: message, status: statusChoice || undefined })
        if (request.current?.fingerprint !== fingerprint) request.current = {
          fingerprint, id: crypto.randomUUID(), payload: { body: message, ...(targetStatus ? { status: targetStatus } : {}) },
        }
        // Metadata refreshes can change item.status. An unchanged draft must replay the original payload too.
        const payload = { ...request.current.payload, request_id: request.current.id }
        const { data } = await feedbackClient.post<{ feedback: FeedbackItem; activity: FeedbackActivity }>(`/${item.id}/replies`, payload)
        if (!mounted.current) return
        onUpdated(data.feedback); setActivities(current => mergeActivities(current, [data.activity]))
      } else {
        const { data } = await feedbackClient.patch<FeedbackItem>(`/${item.id}`, { status: targetStatus, ...(message ? { note: message } : {}) })
        if (!mounted.current) return
        onUpdated(data)
        // A PATCH returns the feedback; get the authoritative event rather than inventing an actor/time.
        try {
          const page = await feedbackClient.get<ActivityPage>(`/${item.id}/activities`)
          if (mounted.current) { setActivities(current => mergeActivities(current, page.data.items)); setNextCursor(current => loadedOlder.current ? current : page.data.next_cursor); if (page.data.feedback) onUpdated(page.data.feedback) }
        } catch (err) {
          if (mounted.current) setLoadError(onError(err))
        }
      }
      if (!mounted.current) return
      setBody(''); setStatusChoice(''); request.current = null
      setNotice(preview ? '演示回复与进展已更新，仅保留在当前页面。' : reply ? '回复已发送。' : '处理状态已保存。')
      window.setTimeout(() => { if (mounted.current) replyField.current?.focus() }, 0)
    } catch (err) { if (mounted.current) setError(onError(err)) }
    finally { submitting.current = false; if (mounted.current) setPending(false) }
  }

  return <div className="feedback-modal-backdrop feedback-discussion-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
    <div className="feedback-dialog feedback-discussion" role="dialog" aria-modal="true" aria-labelledby="feedback-detail-title" ref={dialog} onKeyDown={handleKeys}>
      {confirmDiscard ? <div className="feedback-discard">
        <span className="feedback-dialog-icon"><AlertCircle size={23} /></span>
        <h2 id="feedback-detail-title">放弃未发送的回复？</h2>
        <p>回复内容和选定的状态还未保存，关闭后将不会保留。</p>
        <div className="feedback-dialog-actions"><button ref={continueEditing} type="button" className="feedback-outline-button" onClick={() => setConfirmDiscard(false)}>继续编辑</button><button type="button" className="feedback-danger-button" onClick={onClose}>放弃并关闭</button></div>
      </div> : <>
        <header className="feedback-dialog-header"><div><div className="feedback-dialog-kicker">FEEDBACK & PROGRESS</div><h2 ref={title} tabIndex={-1} id="feedback-detail-title">反馈详情</h2><p>补充信息、交流进展，也让处理结果有据可查。</p></div><button type="button" className="feedback-icon-button" aria-label="关闭详情" disabled={pending} onClick={requestClose}><X size={20} /></button></header>
        <div className="feedback-discussion-content">
          <section className="feedback-original" aria-label="原始反馈">
            <div className="feedback-item-top"><div className="feedback-item-tags"><span className={`feedback-category feedback-category--${item.category}`}>{item.category === 'bug' ? 'Bug 问题' : '新功能建议'}</span><span className={`feedback-status feedback-status--${item.status}`}><i className={`feedback-dot feedback-dot--${item.status}`} />{statusLabels[item.status]}</span>{item.is_mine && <span className="feedback-mine-tag">我的反馈</span>}</div><time dateTime={item.created_at}>{formatDate(item.created_at)}</time></div>
            <p className="feedback-description">{item.description}</p>
            {!!item.images.length && <div className="feedback-images">{item.images.map((id, index) => <a key={id} href={imageUrl(id)} target="_blank" rel="noopener noreferrer" aria-label={`查看原图 ${index + 1}（新标签页打开）`}><img src={imageUrl(id)} alt={`反馈图片 ${index + 1}`} loading="lazy" /><span><ArrowUpRight size={14} /></span></a>)}</div>}
            <div className="feedback-author"><span className="feedback-author-avatar" aria-hidden="true">{Array.from(item.author_name || '同')[0]}</span>{item.author_name}<span>提交于 {formatDate(item.created_at)}</span></div>
          </section>
          <section className="feedback-history" aria-label="处理记录" aria-busy={loading}>
            <h3><MessageSquareText size={17} />回复与处理记录<span>{item.reply_count ?? 0} 条回复</span><button type="button" className="feedback-history-refresh" aria-label="刷新处理记录" title="刷新处理记录，保留未发送内容" disabled={pending || loading || loadingOlder} onClick={() => void retry()}><RefreshCw size={14} />刷新</button></h3>
            {loading ? <p className="feedback-history-empty"><RefreshCw size={16} className="feedback-spin" />正在加载处理记录…</p> : loadError ? <div className="feedback-history-error" role="alert"><p>{loadError}</p><button className="feedback-outline-button" type="button" onClick={() => void retry()}>重新加载处理记录</button></div> : <>
              {nextCursor && <button type="button" className="feedback-history-older" disabled={loadingOlder || pending} onClick={() => void loadOlder()}>{loadingOlder ? '正在加载更早记录…' : '加载更早记录'}</button>}
              {olderError && <p className="feedback-history-error" role="alert">{olderError}，请重试加载更早记录。</p>}
              {!activities.length ? <p className="feedback-history-empty">还没有回复或处理记录。可以补充问题细节，或说明处理进展。</p> : <ol className="feedback-timeline">{activities.map(activity => <li key={activity.id}>
                <span className={`feedback-timeline-dot ${activity.kind === 'status' ? 'is-status' : ''}`} aria-hidden="true">{activity.kind === 'status' ? <CheckCircle2 size={14} /> : <MessageSquareText size={14} />}</span>
                <div className="feedback-timeline-content"><div className="feedback-timeline-meta"><strong>{activity.author_name}</strong><time dateTime={activity.created_at}>{formatDate(activity.created_at)}</time></div>
                  {activity.kind === 'status' && activity.to_status && <p className="feedback-status-change">{activity.from_status ? `${statusLabels[activity.from_status]} → ` : ''}{statusLabels[activity.to_status]}</p>}
                  {activity.body && <p className="feedback-reply-body">{activity.body}</p>}
                </div>
              </li>)}</ol>}
            </>}
          </section>
          <form className="feedback-reply-form" onSubmit={event => { event.preventDefault(); void save(true) }}>
            <div className="feedback-field-heading"><label htmlFor="feedback-reply-body">回复内容</label><span>{body.length} / 2000</span></div>
            <textarea ref={replyField} id="feedback-reply-body" maxLength={2000} rows={4} value={body} disabled={pending} onChange={event => { setBody(event.target.value); setError('') }} placeholder="补充问题细节，说明处理进展或修复结果…" />
            <div className="feedback-reply-status"><label htmlFor="feedback-reply-status">处理状态</label><select ref={statusField} id="feedback-reply-status" value={statusChoice} disabled={pending} onChange={event => { setStatusChoice(event.target.value as FeedbackStatus | ''); setError('') }}><option value="">保持当前状态（{statusLabels[item.status]}）</option><option value="open">待处理</option><option value="in_progress">处理中</option><option value="fixed">已修复</option></select></div>
            <p className="feedback-field-help">回复对组织内成员可见。选择新状态后，填写的说明会与状态一同保存。</p>
            {error && <div className="feedback-form-error" role="alert"><AlertCircle size={15} />{error}</div>}
            {notice && <div className="feedback-discussion-notice" role="status"><CheckCircle2 size={16} />{notice}</div>}
            <div className="feedback-reply-actions"><button type="button" className="feedback-outline-button" disabled={blocked || !targetStatus} onClick={() => void save(false)}>保存状态</button><button type="submit" className="feedback-create" disabled={blocked || !body.trim()}>{pending ? <RefreshCw size={16} className="feedback-spin" /> : <Send size={16} />}{pending ? '正在保存…' : '发送回复'}</button></div>
          </form>
        </div>
      </>}
    </div>
  </div>
}
