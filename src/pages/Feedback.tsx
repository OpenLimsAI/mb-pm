import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { AlertCircle, ArrowUpRight, Bell, Bug, Check, ChevronRight, CircleDot, Lightbulb, MessageSquareText, Plus, RefreshCw, Search, ShieldCheck, Star, ThumbsUp, Trash2, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import ApplicationActions from '../components/application/ApplicationActions'
import { usePortalContext } from '../components/portal/context'
import FeedbackComposer from '../features/feedback/FeedbackComposer'
import FeedbackDiscussion from '../features/feedback/FeedbackDiscussion'
import FeedbackNotifications from '../features/feedback/FeedbackNotifications'
import FeedbackWorkbench from '../features/feedback/FeedbackWorkbench'
import { getFeedbackSource } from '../features/feedback/source'
import { activityTime, applicationLabel, applicationLabels, feedbackClient as client, formatDate, imageUrl, issueLabel, statusLabels, type FeedbackActivity, type FeedbackItem, type FeedbackStatus } from '../features/feedback/shared'
import '../features/information/information.css'
import '../styles/feedback.css'

const demoItems: FeedbackItem[] = [
  { id: 'demo-1', category: 'bug', description: '项目列表页面在切换筛选条件后显示不完整。', status: 'open', author_name: '演示成员', created_at: '2026-10-25T09:30:00Z', images: [], can_delete: true, can_edit: true, is_mine: true, reply_count: 0, workflow_version: 2, number: 'FB-0001' },
  { id: 'demo-2', category: 'feature', description: '希望可以在任务列表中按负责人快速筛选。', status: 'fixed', author_name: '演示成员', created_at: '2026-10-24T09:30:00Z', images: [], can_delete: true, can_edit: true, can_manage: true, can_reopen: true, can_claim: false, is_mine: true, reply_count: 0, workflow_version: 1, number: 'FB-0002' },
]
function errorMessage(error: unknown) {
  if (axios.isAxiosError(error) && typeof error.response?.data?.detail === 'string') return error.response.data.detail
  return '暂时无法完成操作，请检查网络后重试。'
}
export default function Feedback() {
  const context = usePortalContext()
  return <FeedbackWorkspace key={context.preview ? 'preview' : context.identityNamespace || context.user.id} />
}

function FeedbackWorkspace() {
  const { user, preview, applications, refresh, identityNamespace } = usePortalContext()
  const [params, setParams] = useSearchParams()
  const [source] = useState(() => getFeedbackSource(params))
  const name = user.displayName || user.username
  const namespace = preview ? 'preview' : identityNamespace
  const allowed = preview || applications.some(entry => entry.id === 'feedback' && entry.enabled)
  const [items, setItems] = useState<FeedbackItem[]>(() => preview ? demoItems.map(x => ({ ...x })) : [])
  const [loading, setLoading] = useState(!preview)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [applicationFilter, setApplicationFilter] = useState('all')
  const [scopeFilter, setScopeFilter] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [query, setQuery] = useState('')
  const [composerRequested, setComposerRequested] = useState(false)
  const [prefill, setPrefill] = useState<{ id: string; status?: FeedbackStatus } | null>(null)
  const [previewActivities, setPreviewActivities] = useState<Record<string, FeedbackActivity[]>>({})
  const [deleteTarget, setDeleteTarget] = useState<FeedbackItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [busyItems, setBusyItems] = useState<Set<string>>(new Set())
  const [unread, setUnread] = useState<number | null>(null)
  const itemLocks = useRef(new Set<string>())
  const urls = useRef(new Set<string>())
  const openButton = useRef<HTMLButtonElement>(null)
  const discussionTrigger = useRef<HTMLElement | null>(null)
  const deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const deleteCancel = useRef<HTMLButtonElement>(null)
  const deleteDialog = useRef<HTMLDivElement>(null)
  const [resolvedFeedback, setResolvedFeedback] = useState<{ requested: string; id: string } | null>(null)
  const feedbackId = params.get('feedback')
  const selectedItem = feedbackId ? items.find(x => x.id === (resolvedFeedback?.requested === feedbackId ? resolvedFeedback.id : feedbackId)) : undefined
  const composerOpen = allowed && !loading && !loadError && (composerRequested || params.get('compose') === '1')
  const tab = params.get('tab') === 'workbench' ? 'workbench' : params.get('tab') === 'notifications' ? 'notifications' : 'list'
  const suffix = preview ? '?preview=1' : ''
  const reportError = useCallback((error: unknown) => { if (axios.isAxiosError(error) && error.response?.status === 401) void refresh(); return errorMessage(error) }, [refresh])
  const updateItem = useCallback((updated: FeedbackItem) => {
    for (const id of updated.images) if (id.startsWith('blob:')) urls.current.add(id)
    setItems(current => {
      const old = current.find(x => x.id === updated.id)
      if (old?.revision !== undefined && updated.revision !== undefined && old.revision > updated.revision) return current
      return old ? current.map(x => x.id === updated.id ? { ...x, ...updated } : x) : [updated, ...current]
    })
    setStatusFilter(current => current !== 'all' && current !== updated.status ? 'all' : current)
    setUnread(null)
  }, [])
  const setUnreadCount = useCallback((count: number) => { setUnread(count); if (!count) setItems(current => current.map(item => item.unread_count ? { ...item, unread_count: 0 } : item)) }, [])
  useEffect(() => { const active = urls.current; return () => { active.forEach(url => URL.revokeObjectURL(url)); active.clear() } }, [])
  useEffect(() => {
    if (preview || !allowed) return
    let active = true
    client.get<FeedbackItem[]>('').then(({ data }) => {
      if (!active) return
      setItems(current => {
        const latest = new Map(current.map(item => [item.id, item]))
        const ids = new Set(data.map(item => item.id))
        return [...current.filter(item => !ids.has(item.id)), ...data.map(item => {
          const newer = latest.get(item.id)
          if (!newer) return item
          return item.revision !== undefined && newer.revision !== undefined && item.revision > newer.revision ? { ...newer, ...item } : { ...item, ...newer }
        })]
      })
    }).catch(err => { if (active) setLoadError(reportError(err)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [preview, allowed, reportError])
  useEffect(() => {
    if (!feedbackId || !allowed || preview) return
    let active = true
    client.get<FeedbackItem>(`/${encodeURIComponent(feedbackId)}`).then(({ data }) => {
      if (!active) return
      updateItem(data); setResolvedFeedback({ requested: feedbackId, id: data.id })
      void client.post<FeedbackItem>(`/${encodeURIComponent(data.id)}/read`, {}).then(response => { if (active) updateItem(response.data) }).catch(err => { if (active) setActionError(reportError(err)) })
    }).catch(err => { if (active) setActionError(reportError(err)) })
    return () => { active = false }
  }, [feedbackId, allowed, preview, reportError, updateItem])
  const load = async () => {
    setLoading(true); setLoadError('')
    try { setItems((await client.get<FeedbackItem[]>('')).data) } catch (err) { setLoadError(reportError(err)) } finally { setLoading(false) }
  }
  useEffect(() => {
    if (preview || !allowed) return
    let active = true
    const poll = () => {
      if (document.visibilityState === 'hidden') return
      void client.get<{ unread_count: number }>('/notifications', { params: { unread_only: true } }).then(({ data }) => { if (active) { setUnread(data.unread_count); if (!data.unread_count) setItems(current => current.map(item => item.unread_count ? { ...item, unread_count: 0 } : item)) } }).catch(() => {})
    }
    const timer = window.setInterval(poll, 30000)
    window.addEventListener('focus', poll); document.addEventListener('visibilitychange', poll)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', poll); document.removeEventListener('visibilitychange', poll) }
  }, [preview, allowed])
  const navigateTab = (value: string) => { const next = new URLSearchParams(params); if (value === 'list') next.delete('tab'); else next.set('tab', value); setParams(next) }
  const openDiscussion = (item: FeedbackItem, trigger?: HTMLElement, status?: FeedbackStatus) => {
    updateItem(item); discussionTrigger.current = trigger || document.activeElement as HTMLElement; setPrefill({ id: item.id, status }); setActionError('')
    const next = new URLSearchParams(params); next.delete('compose'); next.set('feedback', item.id); setParams(next)
  }
  const openById = (id: string) => { discussionTrigger.current = document.activeElement as HTMLElement; setPrefill(null); setActionError(''); const next = new URLSearchParams(params); next.set('feedback', id); setParams(next) }
  const closeDiscussion = () => { const next = new URLSearchParams(params); next.delete('feedback'); setParams(next); setPrefill(null); if (discussionTrigger.current?.isConnected) discussionTrigger.current.focus(); else openButton.current?.focus() }
  const closeComposer = () => { setComposerRequested(false); const next = new URLSearchParams(params); next.delete('compose'); setParams(next, { replace: true }); openButton.current?.focus() }
  const clearFilters = () => { setStatusFilter('all'); setCategoryFilter('all'); setApplicationFilter('all'); setScopeFilter('all'); setQuery('') }
  const created = (item: FeedbackItem, transferred: string[]) => { transferred.forEach(url => urls.current.add(url)); setItems(current => [item, ...current]); clearFilters(); closeComposer(); setNotice(preview ? '演示反馈已添加，离开页面后不会保存。' : '反馈已提交，感谢你的反馈。') }
  const interact = async (item: FeedbackItem, kind: 'vote' | 'follow') => {
    if (itemLocks.current.has(item.id)) return
    itemLocks.current.add(item.id); setBusyItems(current => new Set(current).add(item.id)); setActionError('')
    try {
      const enabled = kind === 'vote' ? !item.has_voted : !item.is_following
      const updated = preview ? { ...item, ...(kind === 'vote' ? { has_voted: enabled, vote_count: Math.max(0, (item.vote_count || 0) + (enabled ? 1 : -1)) } : { is_following: enabled }) } : (await client.put<FeedbackItem>(`/${item.id}/${kind}`, { enabled })).data
      updateItem(updated)
    } catch (err) { setActionError(reportError(err)) }
    finally { itemLocks.current.delete(item.id); setBusyItems(current => { const next = new Set(current); next.delete(item.id); return next }) }
  }
  const closeDelete = () => { if (deleting) return; setDeleteTarget(null); setDeleteError(''); deleteTrigger.current?.focus() }
  useEffect(() => {
    if (!deleteTarget) return
    deleteCancel.current?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) { event.preventDefault(); setDeleteTarget(null); setDeleteError(''); deleteTrigger.current?.focus() }
      if (event.key !== 'Tab') return
      const buttons = deleteDialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])'); if (!buttons?.length) return
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus() } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus() }
    }
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler)
  }, [deleteTarget, deleting])
  const remove = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true); setDeleteError('')
    try {
      if (!preview) await client.delete(`/${deleteTarget.id}`)
      else deleteTarget.images.filter(id => id.startsWith('blob:')).forEach(id => { URL.revokeObjectURL(id); urls.current.delete(id) })
      setItems(current => current.filter(x => x.id !== deleteTarget.id)); setDeleteTarget(null); setNotice(preview ? '演示反馈已删除，正式数据未受影响。' : '反馈已删除。'); openButton.current?.focus()
    } catch (err) { setDeleteError(reportError(err)) } finally { setDeleting(false) }
  }
  if (!allowed) return <main className="portal-panel"><h1>回音壁暂时不可用</h1><p>请返回工作台刷新登录身份。</p><Link to="/">返回应用工作台</Link></main>
  const text = query.trim().toLocaleLowerCase()
  const visible = items.filter(item => (statusFilter === 'all' || item.status === statusFilter) && (categoryFilter === 'all' || item.category === categoryFilter) && (applicationFilter === 'all' || (applicationFilter === 'unclassified' ? !item.application : item.application === applicationFilter)) && (scopeFilter !== 'mine' || item.is_mine) && (scopeFilter !== 'unanswered' || !item.reply_count) && (scopeFilter !== 'following' || item.is_following) && (!text || `${issueLabel(item)} ${item.description} ${item.author_name}`.toLocaleLowerCase().includes(text)))
    .sort((a, b) => activityTime(sortBy === 'active' ? b.last_activity_at || b.created_at : b.created_at) - activityTime(sortBy === 'active' ? a.last_activity_at || a.created_at : a.created_at) || b.id.localeCompare(a.id))
  const filtersActive = statusFilter !== 'all' || categoryFilter !== 'all' || applicationFilter !== 'all' || scopeFilter !== 'all' || !!query.trim()
  const unreadCount = unread ?? items.reduce((sum, item) => sum + (item.unread_count || 0), 0)
  return <div className="information-app feedback-app"><a className="if-skip" href="#feedback-content">跳至回音壁内容</a>
    <header className="if-header"><Link to={'/' + suffix} className="if-brand" aria-label="迈博药业应用工作台首页"><img src="/brand/maibo-pharma-logo.png" alt="迈博药业" width={44} height={44} /><span className="if-brand-copy"><strong>迈博药业</strong><span>数字化工作空间</span></span></Link><span className="if-app-name">回音壁</span><div className="if-header-actions"><span className="if-header-note"><ShieldCheck size={14} />{preview ? '界面体验 · 演示数据' : '组织成员 · 共享反馈'}</span><ApplicationActions userName={name} preview={preview} /></div></header>
    <div className="if-shell"><aside className="if-sidebar feedback-sidebar"><nav aria-label="回音壁导航"><p className="if-nav-group">反馈与协作</p>{[['list', '反馈列表'], ['workbench', '处理工作台'], ['notifications', '通知中心']].map(([value, label]) => <button key={value} type="button" className={`if-nav ${tab === value ? 'is-active' : ''}`} aria-current={tab === value ? 'page' : undefined} onClick={() => navigateTab(value)}>{value === 'notifications' ? <Bell size={19} /> : <MessageSquareText size={19} />}<span>{label}</span>{value === 'notifications' && unreadCount > 0 && <span className="feedback-unread-badge">{unreadCount}</span>}</button>)}</nav><div className="feedback-side-note"><strong>每一个声音都值得被听见</strong><p>记录问题、沟通进展，发布后再验证结果。</p></div></aside>
      <main className="if-main feedback-main" id="feedback-content"><div className="feedback-intro"><div><div className="feedback-breadcrumb">应用工作台 <ChevronRight size={13} /> 回音壁</div><h1>回音壁</h1><p>让问题被记录，让处理有回音。</p></div><button ref={openButton} type="button" className="feedback-create" disabled={loading || !!loadError} onClick={() => { setActionError(''); setNotice(''); setComposerRequested(true) }}><Plus size={18} />提交反馈</button></div>
        {preview && <div className="feedback-preview"><ShieldCheck size={16} />当前为界面体验，反馈不会提交到正式系统。草稿仅保存在当前浏览器。</div>}
        {actionError && <div className="feedback-banner feedback-banner--error" role="alert"><AlertCircle size={17} />{actionError}</div>}{notice && <div className="feedback-banner feedback-banner--success" role="status">{notice}</div>}
        {feedbackId && !selectedItem && !actionError && <p role="status">正在打开反馈…</p>}
        {tab === 'workbench' ? <FeedbackWorkbench preview={preview} previewItems={items} userId={preview ? 'preview' : user.id} onOpen={item => openDiscussion(item)} onError={reportError} /> : tab === 'notifications' ? <FeedbackNotifications preview={preview} onOpen={openById} onError={reportError} onCount={setUnreadCount} /> : <>
          <section className="feedback-summary" aria-label="反馈概况"><div className="feedback-summary-copy"><span className="feedback-summary-icon"><MessageSquareText size={20} /></span><div><strong>一起让工作更好</strong><p>从发现问题到发布验证，每一步都能看见。</p></div></div><div className="feedback-metrics"><div><strong>{loading || loadError ? '—' : items.length}</strong><span>全部反馈</span></div>{(['open', 'in_progress', 'ready', 'released', 'fixed'] as const).map(status => <div key={status}><strong>{loading || loadError ? '—' : items.filter(x => x.status === status).length}</strong><span><i className={`feedback-dot feedback-dot--${status}`} />{statusLabels[status]}</span></div>)}</div></section>
          <section className="feedback-board" aria-labelledby="feedback-list-title"><div className="feedback-board-heading"><div><h2 id="feedback-list-title">反馈列表 <span>{loading || loadError ? '' : items.length}</span></h2><p>查看反馈、关注进展，提交后会生成可分享的编号。</p></div><span className="feedback-sharing"><ShieldCheck size={14} />组织内可见</span></div>
            <div className="feedback-list-controls"><div className="feedback-scopes" role="group" aria-label="反馈范围">{[['all', '全部反馈'], ['mine', '我的反馈'], ['unanswered', '未回复'], ['following', '我关注的']].map(([value, label]) => <button key={value} type="button" aria-pressed={scopeFilter === value} onClick={() => setScopeFilter(value)}>{label}</button>)}</div><label className="feedback-sort">排序<select aria-label="反馈排序" value={sortBy} onChange={event => setSortBy(event.target.value)}><option value="newest">最近提交</option><option value="active">最近活跃</option></select></label></div>
            <div className="feedback-toolbar"><div className="feedback-search"><Search size={17} /><input aria-label="搜索反馈" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索编号、内容或提交人" />{query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={15} /></button>}</div><div className="feedback-filters"><label>应用<select aria-label="应用筛选" value={applicationFilter} onChange={event => setApplicationFilter(event.target.value)}><option value="all">全部应用</option><option value="unclassified">未分类</option>{Object.entries(applicationLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label>状态<select aria-label="状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label>分类<select aria-label="分类" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value)}><option value="all">全部分类</option><option value="bug">Bug 问题</option><option value="feature">新功能建议</option></select></label></div></div>
            {loading ? <div className="feedback-empty"><RefreshCw className="feedback-spin" size={24} />正在加载反馈</div> : loadError ? <div className="feedback-empty feedback-load-error" role="alert"><strong>暂时无法加载反馈</strong><p>{loadError}</p><button type="button" className="feedback-outline-button" onClick={() => void load()}>重新加载</button></div> : !items.length ? <div className="feedback-empty"><strong>还没有反馈</strong><p>遇到问题或有新的想法，欢迎提交第一条反馈。</p><button type="button" className="feedback-outline-button" onClick={() => setComposerRequested(true)}>提交反馈</button></div> : !visible.length ? <div className="feedback-empty"><strong>没有找到匹配的反馈</strong>{filtersActive && <button type="button" className="feedback-outline-button" onClick={clearFilters}>清除筛选</button>}</div> : <div className="feedback-items">{visible.map(item => <article className="feedback-item" key={item.id}><div className="feedback-item-top"><div className="feedback-item-tags"><button type="button" className="feedback-issue-number" onClick={event => openDiscussion(item, event.currentTarget)}>{issueLabel(item)}</button><span className="feedback-application-tag">{applicationLabel(item.application)}</span><span className={`feedback-category feedback-category--${item.category}`}>{item.category === 'bug' ? <Bug size={13} /> : <Lightbulb size={13} />}{item.category === 'bug' ? 'Bug 问题' : '新功能建议'}</span><span className={`feedback-status feedback-status--${item.status}`}>{statusLabels[item.status]}</span>{item.is_mine && <span className="feedback-mine-tag">我的反馈</span>}{!!item.unread_count && <span className="feedback-unread-badge">{item.unread_count} 条未读</span>}</div><time dateTime={item.created_at}>{formatDate(item.created_at)}</time></div><p className={`feedback-description${item.description.length > 300 ? ' feedback-description--clamped' : ''}`}>{item.description}</p>{item.description.length > 300 && <button type="button" className="feedback-read-more" onClick={event => openDiscussion(item, event.currentTarget)}>查看完整反馈</button>}{!!item.images.length && <div className="feedback-images">{item.images.map((id, index) => <a key={id} href={imageUrl(id)} target="_blank" rel="noopener noreferrer" aria-label={`查看图片 ${index + 1}（新窗口打开）`}><img src={imageUrl(id)} alt={`反馈图片 ${index + 1}`} loading="lazy" /><span><ArrowUpRight size={14} /></span></a>)}</div>}<div className="feedback-card-management"><span>负责人：{item.assignee_name || '待认领'}</span>{item.is_overdue && <span className="is-overdue">已逾期</span>}{item.due_at && <span>计划完成 {formatDate(item.due_at)}</span>}</div><div className="feedback-item-bottom"><div className="feedback-author"><span className="feedback-author-avatar">{Array.from(item.author_name || '同')[0]}</span>{item.author_name}</div><div className="feedback-item-actions"><button type="button" className="feedback-subtle-button" disabled={busyItems.has(item.id)} aria-pressed={!!item.has_voted} onClick={() => void interact(item, 'vote')}><ThumbsUp size={14} />有同样问题 {item.vote_count || 0}</button><button type="button" className="feedback-subtle-button" disabled={busyItems.has(item.id)} aria-pressed={!!item.is_following} onClick={() => void interact(item, 'follow')}><Star size={14} />{item.is_following ? '已关注' : '关注反馈'}</button>{item.can_delete && <button type="button" className="feedback-delete-button" onClick={event => { deleteTrigger.current = event.currentTarget; setDeleteError(''); setDeleteTarget(item) }}><Trash2 size={15} />删除反馈</button>}<button type="button" className="feedback-status-button feedback-replies-button" onClick={event => openDiscussion(item, event.currentTarget)}><MessageSquareText size={15} />回复与进展 <span>{item.reply_count || 0}</span></button>{item.workflow_version !== 2 && item.status === 'fixed' && <button type="button" className="feedback-status-button" onClick={event => openDiscussion(item, event.currentTarget)}>{item.status === 'fixed' ? <><CircleDot size={15} />重新打开</> : <><Check size={15} />标记为已修复</>}</button>}</div></div></article>)}</div>}
            {!loading && !loadError && !!items.length && <div className="feedback-board-footer">{filtersActive ? `显示 ${visible.length} 条，全部 ${items.length} 条` : `共 ${items.length} 条反馈`}<span>反馈对组织内成员可见</span></div>}
          </section></>}
      </main>
    </div>
    {selectedItem && !composerOpen && <FeedbackDiscussion key={selectedItem.id} item={selectedItem} initialStatus={prefill?.id === selectedItem.id ? prefill.status : undefined} preview={preview} userName={name} namespace={namespace} previewActivities={previewActivities[selectedItem.id] || []} onPreviewActivity={activity => { for (const image of activity.images || []) if (image.startsWith('blob:')) urls.current.add(image); setPreviewActivities(current => ({ ...current, [selectedItem.id]: [...(current[selectedItem.id] || []), activity] })) }} onUpdated={updateItem} onError={reportError} onClose={closeDiscussion} />}
    {composerOpen && <FeedbackComposer preview={preview} userName={name} namespace={namespace} source={source} onCreated={created} onClose={closeComposer} onError={reportError} />}
    {deleteTarget && <div className="feedback-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeDelete() }}><div ref={deleteDialog} className="feedback-dialog feedback-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-delete-title" aria-describedby="feedback-delete-warning"><span className="feedback-delete-icon"><Trash2 size={22} /></span><h2 id="feedback-delete-title">删除这条反馈？</h2><p id="feedback-delete-warning">删除后无法恢复，图片、回复和处理记录也会一并删除。</p><div className="feedback-delete-excerpt">{deleteTarget.description}</div>{deleteError && <div className="feedback-form-error" role="alert">{deleteError}</div>}<div className="feedback-dialog-actions"><button ref={deleteCancel} type="button" className="feedback-outline-button" disabled={deleting} onClick={closeDelete}>取消</button><button type="button" className="feedback-danger-button" disabled={deleting} onClick={() => void remove()}>{deleting ? '正在删除…' : '确认删除'}</button></div></div></div>}
  </div>
}
