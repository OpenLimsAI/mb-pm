import { useEffect, useState, type FormEvent } from 'react'
import axios from 'axios'
import { ClipboardList, LayoutGrid, LogOut, Plus, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { usePortalContext } from '../components/portal/context'
import { API_BASE } from '../api/client'
import '../features/information/information.css'
import '../styles/feedback.css'

type FeedbackItem = { id: string; category: 'bug' | 'feature'; description: string; status: 'open' | 'fixed'; author_name: string; created_at: string; images: string[] }
const client = axios.create({ baseURL: `${API_BASE}/feedback`, withCredentials: true, timeout: 30000 })
function message(error: unknown) {
  if (axios.isAxiosError(error) && typeof error.response?.data?.detail === 'string') return error.response.data.detail
  return '操作未完成，请检查网络后重试。'
}

export default function Feedback() {
  const { user, logout, preview, applications, refresh } = usePortalContext()
  const suffix = preview ? '?preview=1' : ''
  const name = user.displayName || user.username
  const allowed = preview || applications.some((entry) => entry.id === 'feedback' && entry.enabled)
  const [items, setItems] = useState<FeedbackItem[]>(() => preview ? [
    { id: 'demo-1', category: 'bug', description: '项目列表页面在切换筛选条件后显示不完整。', status: 'open', author_name: '演示成员', created_at: '2026-10-25T09:30:00Z', images: [] },
    { id: 'demo-2', category: 'feature', description: '希望可以在任务列表中按负责人快速筛选。', status: 'fixed', author_name: '演示成员', created_at: '2026-10-24T09:30:00Z', images: [] },
  ] : [])
  const [loading, setLoading] = useState(!preview)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [category, setCategory] = useState<'bug' | 'feature'>('bug')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [fileKey, setFileKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('all')
  const load = async () => {
    setLoading(true); setError('')
    try { const response = await client.get<FeedbackItem[]>(''); setItems(response.data) }
    catch (err) { if (axios.isAxiosError(err) && err.response?.status === 401) void refresh(); setError(message(err)) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    if (preview || !allowed) return
    let active = true
    client.get<FeedbackItem[]>('').then((response) => { if (active) setItems(response.data) })
      .catch((err: unknown) => { if (active) { if (axios.isAxiosError(err) && err.response?.status === 401) void refresh(); setError(message(err)) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [preview, allowed, refresh])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('')
    if (!description.trim()) { setError('请填写反馈描述。'); return }
    if (files.length > 3 || files.some((file) => file.size > 5 * 1024 * 1024)) { setError('最多上传 3 张图片，每张不超过 5 MB。'); return }
    if (preview) {
      setItems((current) => [{ id: `demo-${Date.now()}`, category, description: description.trim(), status: 'open', author_name: name, created_at: new Date().toISOString(), images: [] }, ...current])
      setDescription(''); setFiles([]); setFileKey((key) => key + 1); setNotice('演示：反馈已添加到当前页面，未提交到服务器。'); return
    }
    const data = new FormData(); data.append('category', category); data.append('description', description.trim())
    files.forEach((file) => data.append('images', file))
    setBusy(true)
    try {
      const response = await client.post<FeedbackItem>('', data)
      setItems((current) => [response.data, ...current]); setDescription(''); setFiles([]); setFileKey((key) => key + 1); setNotice('反馈已提交，谢谢你的建议。')
    } catch (err) { if (axios.isAxiosError(err) && err.response?.status === 401) void refresh(); setError(message(err)) } finally { setBusy(false) }
  }
  const changeStatus = async (item: FeedbackItem) => {
    if (preview) {
      setItems((current) => current.map((row) => row.id === item.id ? { ...row, status: row.status === 'open' ? 'fixed' : 'open' } : row))
      setNotice('演示：状态已更新，未提交到服务器。'); setError(''); return
    }
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await client.patch<FeedbackItem>(`/${item.id}`, { status: item.status === 'open' ? 'fixed' : 'open' })
      setItems((current) => current.map((row) => row.id === item.id ? response.data : row))
      setNotice(response.data.status === 'fixed' ? '已标记为已修复。' : '已重新打开反馈。')
    } catch (err) { if (axios.isAxiosError(err) && err.response?.status === 401) void refresh(); setError(message(err)) } finally { setBusy(false) }
  }
  if (!allowed) {
    return <main className="portal-panel"><h1>回音壁暂时不可用</h1><p>请返回工作台刷新登录身份。</p><Link to="/">返回应用工作台</Link></main>
  }
  const visible = items.filter((item) => filter === 'all' || item.status === filter)
  return <div className="information-app feedback-app">
    <a className="if-skip" href="#feedback-content">跳至回音壁内容</a>
    <header className="if-header">
      <Link to={'/' + suffix} className="if-brand" aria-label="迈博药业应用工作台首页"><img src="/brand/maibo-pharma-logo.png" alt="迈博药业" width={44} height={44} /><span className="if-brand-copy"><strong>迈博药业</strong><span>数字化工作空间</span></span></Link>
      <span className="if-app-name">回音壁</span>
      <div className="if-header-actions"><span className="if-header-note"><ShieldCheck size={14} />{preview ? '界面体验 · 演示数据' : '组织成员 · 共享反馈'}</span>
        <Link className="if-workbench" to={'/' + suffix}><LayoutGrid size={17} /><span>应用工作台</span></Link>
        <Link className="if-account" to={'/settings' + suffix} aria-label={`${name} · 我的设置`}><span className="if-avatar">{Array.from(name)[0]}</span><span className="if-account-copy"><strong>{name}</strong><span>{preview ? '界面预览账号' : '当前登录账号'}</span></span></Link>
        <button type="button" className="if-logout" onClick={logout} disabled={preview} aria-label="退出登录"><LogOut size={17} /><span>退出登录</span></button>
      </div>
    </header>
    <div className="if-shell"><aside className="if-sidebar"><nav aria-label="回音壁导航"><p className="if-nav-group">反馈与建议</p><a className="if-nav is-active" href="#feedback-list"><ClipboardList size={19} /><span>反馈列表</span></a><a className="if-nav" href="#feedback-form"><Plus size={19} /><span>提交反馈</span></a></nav></aside>
    <main className="if-main" id="feedback-content"><div className="if-titlebar"><div><p className="if-eyebrow">FEEDBACK CENTER</p><h1>回音壁</h1><p className="if-caption">遇到问题或有新想法？告诉我们，一起让系统更好用。</p></div></div>
    {preview && <div className="if-message is-info"><ShieldCheck size={17} /><span>界面体验：以下为演示数据，操作不会写入真实反馈；演示时图片不会保存或显示。</span></div>}
    {error && <div className="if-message is-error" role="alert">{error}</div>}{notice && <div className="if-message is-notice" role="status">{notice}</div>}
    <div className="feedback-overview"><div><span>全部反馈</span><strong>{loading ? '—' : items.length}</strong></div><div><span>待处理</span><strong>{loading ? '—' : items.filter((item) => item.status === 'open').length}</strong></div><div><span>已修复</span><strong>{loading ? '—' : items.filter((item) => item.status === 'fixed').length}</strong></div></div>
    <div className="feedback-layout">
      <section id="feedback-form" className="if-panel feedback-form"><h2>提交反馈</h2><p className="feedback-hint">反馈及图片对组织内登录用户可见，请勿包含敏感信息。</p>
        <form onSubmit={(event) => { void submit(event) }}>
          <label htmlFor="feedback-category">反馈分类</label><select id="feedback-category" value={category} onChange={(event) => setCategory(event.target.value as 'bug' | 'feature')}><option value="bug">Bug · 问题</option><option value="feature">New Feature · 新功能</option></select>
          <label htmlFor="feedback-description">问题或建议</label><textarea id="feedback-description" required maxLength={5000} rows={7} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="请描述遇到的问题、操作步骤，或你希望增加的功能…" /><span className="feedback-count">{description.length} / 5000</span>
          <label htmlFor="feedback-images">上传图片（可选）</label><input key={fileKey} id="feedback-images" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => setFiles(Array.from(event.target.files || []))} /><p className="feedback-hint">支持 PNG、JPEG、WebP，最多 3 张，每张不超过 5 MB。</p>
          <button className="if-button is-primary feedback-submit" type="submit" disabled={busy || loading}><Plus size={16} />提交反馈</button>
        </form>
      </section>
      <section id="feedback-list" className="if-panel feedback-list"><div className="feedback-list-heading"><div><h2>反馈列表</h2><p className="feedback-hint">所有成员都可以查看反馈并更新修复状态。</p></div><label>状态 <select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部</option><option value="open">待处理</option><option value="fixed">已修复</option></select></label></div>
        {loading ? <p className="feedback-empty">正在加载反馈…</p> : visible.length === 0 ? <p className="feedback-empty">{filter === 'all' ? '暂无反馈，欢迎提交第一条。' : '当前状态下暂无反馈。'}</p> : <div>{visible.map((item) => <article className="feedback-item" key={item.id}>
          <div className="feedback-item-meta"><span className="feedback-category">{item.category === 'bug' ? 'Bug' : 'New Feature'}</span><span className={`feedback-status feedback-status--${item.status}`}>{item.status === 'fixed' ? '已修复' : '待处理'}</span><span>{item.author_name} · {new Date(item.created_at.endsWith('Z') || /[+-]\d\d:\d\d$/.test(item.created_at) ? item.created_at : item.created_at + 'Z').toLocaleString('zh-CN')}</span></div>
          <p className="feedback-description">{item.description}</p>
          {item.images.length > 0 && <div className="feedback-images">{item.images.map((id) => <a key={id} href={`${API_BASE}/feedback/images/${id}`} target="_blank" rel="noreferrer"><img src={`${API_BASE}/feedback/images/${id}`} alt="反馈附件，点击查看大图" /></a>)}</div>}
          <button type="button" className="feedback-status-button" disabled={busy} onClick={() => { void changeStatus(item) }}>{item.status === 'open' ? '标记为已修复' : '重新打开'}</button>
        </article>)}</div>}
        {!preview && error && !items.length && <button type="button" className="feedback-status-button" onClick={() => { void load() }}>重新加载</button>}
      </section>
    </div><footer className="if-footer"><span>迈博药业 · 回音壁{preview ? ' · 交互演示' : ''}</span><span>{preview ? '演示数据仅保留在当前页面' : '反馈与图片由服务端保存'}</span></footer>
    </main></div>
  </div>
}
