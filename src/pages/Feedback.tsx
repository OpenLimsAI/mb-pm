import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import axios from 'axios'
import { AlertCircle, ArrowUpRight, Bug, Check, CheckCircle2, ChevronRight, CircleDot, ImagePlus, LayoutGrid, Lightbulb, LogOut, MessageSquareText, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { usePortalContext } from '../components/portal/context'
import { API_BASE } from '../api/client'
import '../features/information/information.css'
import '../styles/feedback.css'

type Category = 'bug' | 'feature'
type FeedbackStatus = 'open' | 'fixed'
type FeedbackItem = { id: string; category: Category; description: string; status: FeedbackStatus; author_name: string; created_at: string; images: string[] }
type Attachment = { id: string; file: File; url: string }
const MAX_IMAGE_SIZE = 5 * 1024 * 1024
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const client = axios.create({ baseURL: `${API_BASE}/feedback`, withCredentials: true, timeout: 30000 })
const demoItems: FeedbackItem[] = [
  { id: 'demo-1', category: 'bug', description: '项目列表页面在切换筛选条件后显示不完整。', status: 'open', author_name: '演示成员', created_at: '2026-10-25T09:30:00Z', images: [] },
  { id: 'demo-2', category: 'feature', description: '希望可以在任务列表中按负责人快速筛选。', status: 'fixed', author_name: '演示成员', created_at: '2026-10-24T09:30:00Z', images: [] },
]
function errorMessage(error: unknown) {
  if (axios.isAxiosError(error) && typeof error.response?.data?.detail === 'string') return error.response.data.detail
  return '暂时无法完成操作，请检查网络后重试。'
}
function imageUrl(id: string) { return id.startsWith('blob:') ? id : `${API_BASE}/feedback/images/${id}` }
function formatDate(value: string) {
  const date = new Date(value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z')
  return Number.isNaN(date.valueOf()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

export default function Feedback() {
  const { user, logout, preview, applications, refresh } = usePortalContext()
  const suffix = preview ? '?preview=1' : ''
  const name = user.displayName || user.username
  const allowed = preview || applications.some((entry) => entry.id === 'feedback' && entry.enabled)
  const [items, setItems] = useState<FeedbackItem[]>(() => preview ? demoItems.map((item) => ({ ...item })) : [])
  const [loading, setLoading] = useState(!preview)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [category, setCategory] = useState<Category>('bug')
  const [description, setDescription] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [formError, setFormError] = useState('')
  const [attachmentError, setAttachmentError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [updating, setUpdating] = useState<Set<string>>(() => new Set())
  const urls = useRef(new Set<string>())
  const dialogRef = useRef<HTMLDivElement>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const continueEditingRef = useRef<HTMLButtonElement>(null)

  const revoke = useCallback((url: string) => { if (urls.current.delete(url)) URL.revokeObjectURL(url) }, [])
  useEffect(() => {
    const activeUrls = urls.current
    return () => { activeUrls.forEach((url) => URL.revokeObjectURL(url)); activeUrls.clear() }
  }, [])
  const reportError = useCallback((error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) void refresh()
    return errorMessage(error)
  }, [refresh])
  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try { const response = await client.get<FeedbackItem[]>(''); setItems(response.data) }
    catch (error) { setLoadError(reportError(error)) }
    finally { setLoading(false) }
  }, [reportError])
  useEffect(() => {
    if (preview || !allowed) return
    let active = true
    client.get<FeedbackItem[]>('').then((response) => { if (active) setItems(response.data) })
      .catch((error: unknown) => { if (active) setLoadError(reportError(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [preview, allowed, reportError])
  useEffect(() => {
    if (!composerOpen) return
    if (confirmDiscard) continueEditingRef.current?.focus()
    else descriptionRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]')
      if (!nodes?.length) return
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [composerOpen, confirmDiscard])
  const resetForm = (preserveImages = false) => {
    if (!preserveImages) attachments.forEach((attachment) => revoke(attachment.url))
    setCategory('bug'); setDescription(''); setAttachments([]); setFormError(''); setAttachmentError(''); setConfirmDiscard(false)
  }
  const closeComposer = () => {
    if (submitting) return
    if (description.trim() || attachments.length || category !== 'bug') { setConfirmDiscard(true); return }
    resetForm(); setComposerOpen(false); openButtonRef.current?.focus()
  }
  const discardComposer = () => { resetForm(); setComposerOpen(false); openButtonRef.current?.focus() }
  useEffect(() => {
    if (!composerOpen) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (confirmDiscard) setConfirmDiscard(false)
        else closeComposer()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
    // The handler should reflect the current draft and submission state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerOpen, confirmDiscard, description, attachments, category, submitting])
  const addImages = (selected: File[]) => {
    if (!selected.length) return
    if (attachments.length + selected.length > 3) { setAttachmentError('最多上传 3 张图片，请先移除多余的图片。'); return }
    if (selected.some((file) => !ALLOWED_TYPES.includes(file.type))) { setAttachmentError('仅支持 PNG、JPEG 或 WebP 图片。'); return }
    if (selected.some((file) => file.size > MAX_IMAGE_SIZE)) { setAttachmentError('每张图片不能超过 5 MB。'); return }
    const added = selected.map((file) => {
      const url = URL.createObjectURL(file); urls.current.add(url)
      return { id: url, file, url }
    })
    setAttachments((current) => [...current, ...added]); setAttachmentError('')
  }
  const clearFilters = () => { setStatusFilter('all'); setCategoryFilter('all'); setQuery('') }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setFormError(''); setNotice(''); setActionError('')
    if (!description.trim()) { setFormError('请填写问题或建议。'); descriptionRef.current?.focus(); return }
    if (attachmentError) return
    setSubmitting(true)
    try {
      let item: FeedbackItem
      if (preview) {
        item = { id: `demo-${Date.now()}`, category, description: description.trim(), status: 'open', author_name: name, created_at: new Date().toISOString(), images: attachments.map((attachment) => attachment.url) }
      } else {
        const data = new FormData(); data.append('category', category); data.append('description', description.trim())
        attachments.forEach((attachment) => data.append('images', attachment.file))
        item = (await client.post<FeedbackItem>('', data)).data
      }
      setItems((current) => [item, ...current]); clearFilters(); resetForm(preview); setComposerOpen(false)
      setNotice(preview ? '演示反馈已添加，离开页面后不会保存。' : '反馈已提交，感谢你的反馈。')
      openButtonRef.current?.focus()
    } catch (error) { setFormError(reportError(error)) }
    finally { setSubmitting(false) }
  }
  const changeStatus = async (item: FeedbackItem) => {
    const next: FeedbackStatus = item.status === 'open' ? 'fixed' : 'open'
    setUpdating((current) => new Set(current).add(item.id)); setActionError(''); setNotice('')
    try {
      const updated = preview ? { ...item, status: next } : (await client.patch<FeedbackItem>(`/${item.id}`, { status: next })).data
      setItems((current) => current.map((row) => row.id === item.id ? updated : row))
      if (statusFilter !== 'all' && statusFilter !== updated.status) setStatusFilter('all')
      setNotice(preview ? '演示状态已更新，离开页面后不会保存。' : updated.status === 'fixed' ? '已标记为已修复。' : '反馈已重新打开。')
    } catch (error) { setActionError(reportError(error)) }
    finally { setUpdating((current) => { const nextSet = new Set(current); nextSet.delete(item.id); return nextSet }) }
  }

  if (!allowed) return <main className="portal-panel"><h1>回音壁暂时不可用</h1><p>请返回工作台刷新登录身份。</p><Link to="/">返回应用工作台</Link></main>
  const search = query.trim().toLocaleLowerCase()
  const visible = items.filter((item) => (statusFilter === 'all' || item.status === statusFilter) && (categoryFilter === 'all' || item.category === categoryFilter) && (!search || `${item.description} ${item.author_name}`.toLocaleLowerCase().includes(search)))
  const filtersActive = statusFilter !== 'all' || categoryFilter !== 'all' || !!query.trim()
  const openCount = items.filter((item) => item.status === 'open').length
  const fixedCount = items.length - openCount
  const isEmpty = !items.length
  const countText = loading || loadError ? '—' : String(items.length)
  return <div className="information-app feedback-app">
    <a className="if-skip" href="#feedback-content">跳至回音壁内容</a>
    <header className="if-header">
      <Link to={'/' + suffix} className="if-brand" aria-label="迈博药业应用工作台首页"><img src="/brand/maibo-pharma-logo.png" alt="迈博药业" width={44} height={44} /><span className="if-brand-copy"><strong>迈博药业</strong><span>数字化工作空间</span></span></Link>
      <span className="if-app-name">回音壁</span>
      <div className="if-header-actions"><span className="if-header-note"><ShieldCheck size={14} />{preview ? '界面体验 · 演示数据' : '组织成员 · 共享反馈'}</span>
        <Link className="if-workbench" to={'/' + suffix}><LayoutGrid size={17} /><span>应用工作台</span></Link>
        <Link className="if-account" to={'/settings' + suffix} aria-label={`${name} · 我的设置`}><span className="if-avatar" aria-hidden="true">{Array.from(name)[0]}</span><span className="if-account-copy"><strong>{name}</strong><span>{preview ? '界面预览账号' : '当前登录账号'}</span></span></Link>
        <button type="button" className="if-logout" onClick={logout} disabled={preview} aria-label="退出登录"><LogOut size={17} /><span>退出登录</span></button>
      </div>
    </header>
    <div className="if-shell"><aside className="if-sidebar feedback-sidebar"><nav aria-label="回音壁导航"><p className="if-nav-group">反馈与建议</p><a className="if-nav is-active" href="#feedback-content" aria-current="page"><MessageSquareText size={19} /><span>反馈列表</span></a></nav><div className="feedback-side-note"><span className="feedback-side-icon"><MessageSquareText size={17} /></span><strong>每一个声音都值得被听见</strong><p>在这里分享问题与想法，一起让工作更顺畅。</p></div></aside>
    <main className="if-main feedback-main" id="feedback-content">
      <div className="feedback-intro"><div><div className="feedback-breadcrumb">应用工作台 <ChevronRight size={13} /> 回音壁</div><h1>回音壁</h1><p>记录遇到的问题，分享新的想法，让问题和建议被看见。</p></div><button ref={openButtonRef} type="button" className="feedback-create" disabled={loading || !!loadError} onClick={() => { setActionError(''); setNotice(''); setComposerOpen(true) }}><Plus size={18} />提交反馈</button></div>
      {preview && <div className="feedback-preview"><ShieldCheck size={16} /><span>当前为界面体验，反馈和图片仅保留在本页，不会提交到正式系统。</span></div>}
      {actionError && <div className="feedback-banner feedback-banner--error" role="alert"><AlertCircle size={17} />{actionError}</div>}{notice && <div className="feedback-banner feedback-banner--success" role="status"><CheckCircle2 size={17} />{notice}</div>}
      <section className="feedback-summary" aria-label="反馈概况"><div className="feedback-summary-copy"><span className="feedback-summary-icon"><MessageSquareText size={20} /></span><div><strong>一起让工作更好</strong><p>每一条反馈都会展示在这里，状态清晰可见。</p></div></div><div className="feedback-metrics"><div><strong>{countText}</strong><span>全部反馈</span></div><div><strong>{loading || loadError ? '—' : openCount}</strong><span><i className="feedback-dot feedback-dot--open" />待处理</span></div><div><strong>{loading || loadError ? '—' : fixedCount}</strong><span><i className="feedback-dot feedback-dot--fixed" />已修复</span></div></div></section>
      <section id="feedback-list" className="feedback-board" aria-labelledby="feedback-list-title">
        <div className="feedback-board-heading"><div><div className="feedback-board-eyebrow">FEEDBACK BOARD</div><h2 id="feedback-list-title">反馈列表 <span>{loading || loadError ? '' : items.length}</span></h2><p>查看团队反馈，关注每一个问题的进展。</p></div><span className="feedback-sharing"><ShieldCheck size={14} />组织内可见</span></div>
        <div className="feedback-toolbar"><div className="feedback-search"><Search size={17} aria-hidden="true" /><input aria-label="搜索反馈" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索反馈内容或提交人" />{query && <button type="button" onClick={() => setQuery('')} aria-label="清除搜索"><X size={15} /></button>}</div><div className="feedback-filters"><label><span>状态</span><select aria-label="状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="open">待处理</option><option value="fixed">已修复</option></select></label><label><span>分类</span><select aria-label="分类" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部分类</option><option value="bug">Bug 问题</option><option value="feature">新功能建议</option></select></label></div></div>
        {loading ? <div className="feedback-empty"><RefreshCw size={24} className="feedback-spin" /><strong>正在加载反馈</strong><p>请稍候，正在获取团队反馈。</p></div> : loadError ? <div className="feedback-empty feedback-load-error" role="alert"><AlertCircle size={26} /><strong>暂时无法加载反馈</strong><p>{loadError}</p><button type="button" className="feedback-outline-button" onClick={() => { void load() }}><RefreshCw size={15} />重新加载</button></div> : isEmpty ? <div className="feedback-empty"><span className="feedback-empty-icon"><MessageSquareText size={25} /></span><strong>还没有反馈</strong><p>遇到问题或有新的想法，欢迎提交第一条反馈。</p><button type="button" className="feedback-outline-button" onClick={() => setComposerOpen(true)}><Plus size={15} />提交反馈</button></div> : visible.length === 0 ? <div className="feedback-empty"><span className="feedback-empty-icon"><Search size={24} /></span><strong>没有找到匹配的反馈</strong><p>试试其他关键词或筛选条件。</p>{filtersActive && <button type="button" className="feedback-outline-button" onClick={clearFilters}>清除筛选</button>}</div> : <div className="feedback-items">{visible.map((item) => <article className="feedback-item" key={item.id}>
          <div className="feedback-item-top"><div className="feedback-item-tags"><span className={`feedback-category feedback-category--${item.category}`}>{item.category === 'bug' ? <Bug size={13} /> : <Lightbulb size={13} />}{item.category === 'bug' ? 'Bug 问题' : '新功能建议'}</span><span className={`feedback-status feedback-status--${item.status}`}><i className={`feedback-dot feedback-dot--${item.status}`} />{item.status === 'fixed' ? '已修复' : '待处理'}</span></div><time dateTime={item.created_at}>{formatDate(item.created_at)}</time></div>
          <p className="feedback-description">{item.description}</p>
          {item.images.length > 0 && <div className="feedback-images">{item.images.map((id, index) => <a key={id} href={imageUrl(id)} target="_blank" rel="noreferrer" aria-label={`查看图片 ${index + 1}（新窗口打开）`}><img src={imageUrl(id)} alt={`反馈图片 ${index + 1}`} loading="lazy" /><span><ArrowUpRight size={14} /></span></a>)}</div>}
          <div className="feedback-item-bottom"><div className="feedback-author"><span className="feedback-author-avatar" aria-hidden="true">{Array.from(item.author_name || '同')[0]}</span><span>{item.author_name}</span></div><button type="button" className="feedback-status-button" disabled={updating.has(item.id)} onClick={() => { void changeStatus(item) }}>{updating.has(item.id) ? '正在更新…' : item.status === 'open' ? <><Check size={15} />标记为已修复</> : <><CircleDot size={15} />重新打开</>}</button></div>
        </article>)}</div>}
        {!loading && !loadError && !isEmpty && <div className="feedback-board-footer">{filtersActive ? `显示 ${visible.length} 条，全部 ${items.length} 条` : `共 ${items.length} 条反馈`}<span>反馈对组织内成员可见</span></div>}
      </section>
      <footer className="feedback-footer"><span>迈博药业 · 回音壁{preview ? ' · 界面体验' : ''}</span><span>{preview ? '演示数据仅保留在当前页面' : '反馈和图片保存在系统中'}</span></footer>
    </main></div>
    {composerOpen && <div className="feedback-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeComposer() }}><div className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-dialog-title" ref={dialogRef}>
      {confirmDiscard ? <div className="feedback-discard"><span className="feedback-dialog-icon"><AlertCircle size={23} /></span><h2 id="feedback-dialog-title">放弃这条反馈？</h2><p>你填写的内容和已选图片还没有提交，关闭后将不会保存。</p><div className="feedback-dialog-actions"><button ref={continueEditingRef} type="button" className="feedback-outline-button" onClick={() => setConfirmDiscard(false)}>继续编辑</button><button type="button" className="feedback-danger-button" onClick={discardComposer}>放弃并关闭</button></div></div> : <><div className="feedback-dialog-header"><div><div className="feedback-dialog-kicker">SHARE YOUR FEEDBACK</div><h2 id="feedback-dialog-title">提交反馈</h2><p>说说你遇到的问题，或分享让系统更好用的想法。</p></div><button type="button" className="feedback-icon-button" aria-label="关闭" disabled={submitting} onClick={closeComposer}><X size={20} /></button></div>
      <form onSubmit={(event) => { void submit(event) }} className="feedback-dialog-form"><fieldset className="feedback-category-picker"><legend>反馈分类</legend><button type="button" aria-pressed={category === 'bug'} className={category === 'bug' ? 'is-selected' : ''} onClick={() => setCategory('bug')}><span><Bug size={18} /></span><div><strong>Bug 问题</strong><small>遇到故障或异常</small></div>{category === 'bug' && <CheckCircle2 size={17} />}</button><button type="button" aria-pressed={category === 'feature'} className={category === 'feature' ? 'is-selected' : ''} onClick={() => setCategory('feature')}><span><Lightbulb size={18} /></span><div><strong>新功能建议</strong><small>分享需求或想法</small></div>{category === 'feature' && <CheckCircle2 size={17} />}</button></fieldset>
        <div className="feedback-field"><div className="feedback-field-heading"><label htmlFor="feedback-description">问题或建议 <span>必填</span></label><span>{description.length} / 5000</span></div><textarea ref={descriptionRef} id="feedback-description" required maxLength={5000} rows={6} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={category === 'bug' ? '请描述遇到的问题，例如发生在哪里、操作步骤和实际结果。' : '请描述你的想法，以及它希望解决什么问题。'} /></div>
        <div className="feedback-field"><div className="feedback-field-heading"><span className="feedback-field-label">图片说明 <span>选填</span></span><span>{attachments.length} / 3</span></div><div className="feedback-attachment-grid">{attachments.map((attachment) => <div className="feedback-attachment" key={attachment.id}><img src={attachment.url} alt={`已添加图片 ${attachment.file.name}`} /><button type="button" aria-label={`移除图片 ${attachment.file.name}`} onClick={() => { revoke(attachment.url); setAttachments((current) => current.filter((entry) => entry.id !== attachment.id)); setAttachmentError('') }}><X size={15} /></button></div>)}{attachments.length < 3 && <label className="feedback-upload"><ImagePlus size={20} /><span>添加图片</span><input aria-label="添加图片" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { addImages(Array.from(event.target.files || [])); event.target.value = '' }} /></label>}</div><p className="feedback-field-help">支持 PNG、JPEG、WebP，最多 3 张，每张不超过 5 MB。</p>{attachmentError && <div className="feedback-form-error" role="alert"><AlertCircle size={15} /><span>{attachmentError}</span><button type="button" onClick={() => setAttachmentError('')}>忽略未添加的图片</button></div>}</div>
        {formError && <div className="feedback-form-error" role="alert"><AlertCircle size={15} />{formError}</div>}
        <div className="feedback-dialog-footer"><p><ShieldCheck size={15} />反馈和图片对组织内登录成员可见。</p><div className="feedback-dialog-actions"><button type="button" className="feedback-outline-button" disabled={submitting} onClick={closeComposer}>取消</button><button type="submit" className="feedback-create" disabled={submitting || loading || !!attachmentError}>{submitting ? '正在提交…' : '提交反馈'}<ChevronRight size={16} /></button></div></div>
      </form></>}
    </div></div>}
  </div>
}
