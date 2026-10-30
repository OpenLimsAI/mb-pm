import ApplicationActions from '../../components/application/ApplicationActions'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Activity, ArrowRight, Bell, Bookmark, Check, CheckCheck, ChevronRight, Clock3, ExternalLink, FileText, Folder, FolderDown, Inbox, LayoutGrid, Library, LoaderCircle, NotebookPen, Pause, Play, Plus, Radio, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import { usePortalContext } from '../../components/portal/context'
import { asAPIError } from '../../api/client'
import { getInformation, changeInformation, searchInformation } from './api'
import { SCOPE_NAMES, type InformationDocument, type InformationJob, type InformationSnapshot, type InformationSource } from './api'
import { demoMutation, demoSeed, demoTick, persistDemo, restoreDemo } from './demo'
import NotesWorkspace from '../notes/NotesWorkspace'
import NoteEditor from '../notes/NoteEditor'
import { newNote } from '../notes/draft'
import type { NoteDraft } from '../notes/draft'
import NoteSelectionCapture from '../notes/NoteSelectionCapture'
import { createPreviewNotesClient, notesApi, noteSourceUrl } from '../notes/client'
import LiveDocumentDetail from './LiveDocumentDetail'
import './information.css'
import './informationTheme.css'

const demoPages = { notes: ['MY NOTES', '我的笔记', '收藏行业摘录，整理研究观察与个人思考。'], home: ['OVERVIEW', '工作台', '体验从来源发现、情报阅读到资料收录的完整流程。'], inbox: ['INTELLIGENCE INBOX', '情报收件箱', '来源变更与收录结果集中查看，个人已读状态单独保存。'], import: ['INITIAL COLLECTION', '批量收录', '用示例清单体验选择文件夹、确认资料与批量收录。'], library: ['KNOWLEDGE MATERIALS', '知识资料', '通过示例资料体验原文、版本和问答状态，不读取生产知识库。'], sources: ['INFORMATION SOURCES', '信息源', '一个 ICH 来源管理四个监控范围，体验分类管理与批量收录。'], following: ['YOUR FOLLOWING', '我的关注', '按来源或分类关注更新，个人偏好与团队监控分别管理。'], runs: ['OPERATIONS', '运行与费用', '体验逐文件进度、来源检查与费用估算，全部为演示。'] } as const
type Page = keyof typeof demoPages
const realPages: Record<Page, readonly [string, string, string]> = { ...demoPages, home: ['OVERVIEW','工作台','查看官方资料、来源检查与团队收录进度。'], import: ['INITIAL COLLECTION','批量收录','从官方网站发现真实文件，选择归档或知识库目标。'], library: ['KNOWLEDGE MATERIALS','知识资料','查阅已发现资料、归档原文、解析正文及历史版本。'], sources: ['INFORMATION SOURCES','信息源','管理 ICH Q/S/E/M 四类真实监控、归档和知识库目标。'], runs: ['OPERATIONS','运行与费用','后台任务持续运行，逐项显示结果及失败原因。'] }
const statusNames: Record<string, string> = { unchecked: '尚未检查', ok: '检查成功', partial: '部分完成', error: '失败', unsupported: '待适配', running: '执行中', pending: '等待处理', queued: '等待处理', paused: '已暂停', cancelled: '已取消', complete: '已完成', completed: '已完成', done: '已完成', discovered: '待收录', archived: '原文已保存', ready: '可用于问答', stored: '原文已保存', saved: '原文已保存', failed: '失败', skipped: '已跳过', linked: '已关联', success: '成功', unavailable: '尚不可用', not_requested: '未要求解析', 'download-failed': '下载失败', 'parse-failed': '原文已保存 · 解析失败', 'retry-pending': '等待重试' }
const statusName = (value?: string) => value ? Object.hasOwn(statusNames, value) ? statusNames[value] : value : '尚未检查'
const dateText = (value?: string | null) => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '暂无记录'
function webUrl(value?: string | null) { if (!value) return undefined; try { const url = new URL(value, window.location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined } catch { return undefined } }
function Status({ value, children }: { value?: string; children?: ReactNode }) { return <span className={`if-status ${['ok', 'ready', 'success', 'completed', 'done'].includes(value || '') ? 'is-good' : ['error', 'failed', 'partial', 'unsupported'].includes(value || '') ? 'is-warn' : ''}`}>{children || statusName(value)}</span> }
function Empty({ icon = <Inbox size={26} />, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) { return <div className="if-empty">{icon}<h2>{title}</h2>{children && <p>{children}</p>}</div> }
function Button({ children, primary, busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; busy?: boolean }) { return <button type="button" {...props} disabled={props.disabled || busy} className={`if-button ${primary ? 'is-primary' : ''} ${props.className || ''}`}>{busy && <LoaderCircle size={16} className="if-spin" aria-hidden="true" />}{children}</button> }

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const initial = ref.current?.querySelector<HTMLElement>('input:not([disabled]):not([hidden]),textarea:not([disabled]),select:not([disabled])')
    ;(initial || ref.current)?.focus({ preventScroll: true })
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const nodes = ref.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]):not([hidden]),textarea:not([disabled]),select:not([disabled])')
      if (!nodes?.length) return
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handle)
    return () => { document.removeEventListener('keydown', handle); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return <div className="if-modal-backdrop"><div className="if-modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}><header className="if-modal-header"><span className="if-modal-mark"><Radio size={19} aria-hidden="true" /></span><h2>{title}</h2><Button onClick={onClose} aria-label="关闭"><X size={18} /></Button></header><div className="if-modal-body">{children}</div></div></div>
}

export default function InformationApp() {
  const { user, identityNamespace, preview } = usePortalContext()
  const notesNamespace = `${identityNamespace || user.id}:${user.id}`
  const notesClient = useMemo(() => preview ? createPreviewNotesClient(notesNamespace) : notesApi, [notesNamespace, preview])
  const noteRoot = useRef<HTMLDivElement>(null)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const pages = preview ? demoPages : realPages
  const location = useLocation()
  const navigate = useNavigate()
  const route = location.pathname.replace(/^\/information\/?/, '').split('/')[0]
  const page: Page = Object.hasOwn(pages, route) ? route as Page : 'sources'
  const suffix = preview ? '?preview=1' : ''
  const storageKey = null
  const [data, setData] = useState<InformationSnapshot | null>(() => preview ? restoreDemo(storageKey) : null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(!preview)
  const mounted = useRef(true)
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const closeAdd = useCallback(() => setAddOpen(false), [])
  const refresh = useCallback(async () => {
    if (preview) { setNotice('演示界面已刷新；没有请求官方网站、知识库或 AI 服务。'); return }
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    try {
      const snapshot = await getInformation(controller.signal)
      if (!controller.signal.aborted && mounted.current) { setData(snapshot); setError('') }
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) {
        const detail = asAPIError(failure).detail
        setError(typeof detail === 'string' ? detail : '读取行业信息服务失败，请稍后重试。')
      }
    } finally { if (!controller.signal.aborted && mounted.current) setLoading(false) }
  }, [preview])
  const running = !!data?.jobs.some(job => job.status === 'running')
  useEffect(() => { if (preview && data) persistDemo(storageKey, data) }, [data, storageKey, preview])
  useEffect(() => {
    if (!preview || !running) return
    const timer = window.setInterval(() => setData(current => current ? demoTick(current) : current), 800)
    return () => window.clearInterval(timer)
  }, [running, preview])
  useEffect(() => {
    mounted.current = true
    const initial = !preview && page !== 'notes' ? window.setTimeout(() => { void refresh() }, 0) : undefined
    const timer = preview || page === 'notes' ? undefined : window.setInterval(() => { if (!document.hidden) void refresh() }, 10000)
    return () => { mounted.current = false; request.current?.abort(); window.clearTimeout(initial); window.clearInterval(timer) }
  }, [preview, refresh, page])
  async function mutate(key: string, method: 'post' | 'patch' | 'put', path: string, body: unknown, message: string) {
    if (busy) return false
    setBusy(key); setError(''); setNotice('')
    try {
      if (preview && data) { setData(demoMutation(data, path, body as Record<string, unknown>)); setNotice(`演示：${message} 未操作真实服务。`) }
      else { await changeInformation(method, path, body); if (!mounted.current) return false; await refresh(); setNotice(message) }
      return true
    } catch (failure) {
      const detail = asAPIError(failure).detail
      if (mounted.current) setError(typeof detail === 'string' ? detail : '操作失败，请检查输入后重试。')
      return false
    } finally { if (mounted.current) setBusy('') }
  }
  const go = (next: Page) => navigate(`/information/${next}${suffix}`)
  const name = user.displayName || user.username
  const heading = pages[page]
  const unread = data?.events.filter(event => !event.read).length || 0
  const nav = (key: Page, label: string, icon: ReactNode, count?: number) => <NavLink key={key} to={`/information/${key}${suffix}`} className={`if-nav ${page === key ? 'is-active' : ''}`} aria-current={page === key ? 'page' : undefined}>{icon}<span>{label}</span>{!!count && <span className="if-nav-count">{count}</span>}</NavLink>
  return <div className="information-app" ref={noteRoot}>
    <a className="if-skip" href="#information-content">跳至行业信息内容</a>
    <header className="if-header"><div className="if-header-identity"><span className="if-app-mark"><Radio size={21} aria-hidden="true" /></span><strong className="if-app-name">行业信息</strong><span className="if-app-subtitle">医药情报工作空间</span><span className="if-header-note"><ShieldCheck size={12} aria-hidden="true" />{preview ? '界面体验 · 演示数据' : '官方来源 · 实际采集'}</span></div><div className="if-header-actions"><ApplicationActions userName={name} preview={preview} /></div></header>
    <div className="if-shell"><aside className="if-sidebar"><nav aria-label="行业信息导航"><p className="if-nav-group">个人工作空间</p>{nav('home', '工作台', <LayoutGrid size={19} />)}{nav('inbox', '情报收件箱', <Inbox size={19} />, unread)}{nav('notes', '我的笔记', <NotebookPen size={19} />)}<p className="if-nav-group">资料与来源</p>{nav('import', '批量收录', <FolderDown size={19} />)}{nav('library', '知识资料', <Library size={19} />)}{nav('sources', '信息源', <Radio size={19} />)}<p className="if-nav-group">关注与运行</p>{nav('following', '我的关注', <Bookmark size={19} />)}{nav('runs', '运行与费用', <Activity size={19} />, data?.jobs.filter(job => job.failed > 0).length)}{data && data.folders.length > 0 && <div className="if-side-folders"><p className="if-nav-group">知识库文件夹</p>{data.folders.map(folder => <Link key={folder.id} to={`/information/library?folder=${encodeURIComponent(folder.id)}${preview ? "&preview=1" : ""}`} className="if-nav"><Folder size={18} /><span>{folder.name}</span><span className="if-nav-count">{data.documents.filter(doc => doc.folderIds.includes(folder.id)).length}</span></Link>)}</div>}</nav></aside>
      <main className="if-main" id="information-content"><div className="if-titlebar"><div><p className="if-eyebrow">{heading[0]}</p><h1>{heading[1]}</h1><p className="if-caption">{heading[2]}</p></div><div className="if-actions">{page === 'sources' && data?.canManage && <Button primary onClick={() => setAddOpen(true)}><Plus size={17} />添加来源</Button>}{page !== 'notes' && <Button onClick={() => { void refresh() }} busy={loading} disabled={!!busy} aria-label="刷新"><RefreshCw size={16} />刷新</Button>}</div></div>
        {page !== 'notes' && error && <div role="alert" className="if-message is-error">{error}</div>}{notice && <div role="status" className="if-message is-notice"><CheckCheck size={17} />{notice}<button type="button" onClick={() => setNotice('')} aria-label="关闭通知"><X size={16} /></button></div>}
        {page !== 'notes' && data && (preview || data.integration.status !== 'ready') && <div className="if-message is-info"><ShieldCheck size={17} /><span>{data.integration.message}</span></div>}
        {page === 'notes' ? <NotesWorkspace key={notesNamespace} client={notesClient} /> : !data ? <Empty title={loading ? '正在读取行业信息服务…' : '暂时无法加载信息'} icon={loading ? <LoaderCircle className="if-spin" /> : <Radio />}>来源、资料和运行结果将在连接成功后显示。</Empty> : <>
          {page === 'sources' && <Sources data={data} busy={busy} mutate={mutate} onImport={id => navigate(`/information/import${suffix}`, { state: { sourceId: id } })} onRuns={() => go('runs')} />}
          {page === 'home' && <Dashboard data={data} go={go} />}
          {page === 'inbox' && <EventInbox data={data} busy={busy} mutate={mutate} />}
          {page === 'library' && <Materials data={data} busy={busy} mutate={mutate} />}
          {page === 'import' && <ImportFlow key={String(location.state?.sourceId || 'default')} data={data} preferredSource={location.state?.sourceId} busy={busy} mutate={mutate} onRuns={() => go('runs')} />}
          {page === 'following' && <Following data={data} busy={busy} mutate={mutate} preview={preview} />}
          {page === 'runs' && <Runs data={data} busy={busy} mutate={mutate} />}
        </>}
        <footer className="if-footer"><span>迈博药业 · 行业信息{preview ? ' · 交互演示' : ''}</span>{preview && page !== 'notes' ? <><Button onClick={() => { setData(demoSeed()); navigate(`/information/sources${suffix}`); setNotice('演示数据已重置。真实业务数据不受影响。'); setError('') }}>重置演示数据</Button><span>演示状态仅在本机保留</span></> : <span>{preview ? '笔记在本机浏览器独立保存' : page === 'notes' ? '笔记按登录身份独立保存' : '团队资料由服务端保存，已读与关注按登录身份隔离'}</span>}</footer>
      </main></div>
    <NoteSelectionCapture root={noteRoot} selector=".if-document-detail,.if-browser-detail" onCapture={(text, element) => {
      const origin = element.closest<HTMLElement>('[data-note-title]')
      const sourceTitle = origin?.dataset.noteTitle || element.querySelector('h2')?.textContent || '行业信息摘录'
      setNoteDraft(newNote({ title: `${sourceTitle}摘录`.slice(0, 200), content: text, sourceApp: 'information', sourceTitle: sourceTitle.slice(0, 500), sourceUrl: noteSourceUrl(origin?.dataset.noteUrl || '') || '/information/library' }))
    }} />
    {noteDraft && <NoteEditor key={noteDraft.id} client={notesClient} draft={noteDraft} onClose={() => setNoteDraft(null)} onSaved={() => { setNoteDraft(null); setNotice('已存入我的笔记。') }} />}
    {addOpen && data?.canManage && <AddSource folders={data.folders} busy={busy} mutate={mutate} onClose={closeAdd} />}
  </div>
}

type Mutate = (key: string, method: 'post' | 'patch' | 'put', path: string, body: unknown, message: string) => Promise<boolean>
type Shared = { data: InformationSnapshot; busy: string; mutate: Mutate }
function Sources({ data, busy, mutate, onImport, onRuns }: Shared & { onImport: (id: string) => void; onRuns: () => void }) {
  if (!data.sources.length) return <section className="if-panel"><Empty icon={<Radio size={28} />} title="还没有信息源">登记来源后，先检查官方网站清单，再选择收录资料。只有已适配来源可以开启监控。</Empty></section>
  return <div className="if-sources">{data.sources.map(source => <section className="if-panel if-source-card" key={source.id}><div className="if-source-heading"><div className="if-source-logo">{source.adapter === 'ich' ? 'ICH' : <Radio size={25} />}</div><div className="if-source-title"><h2>{source.name}</h2><a href={webUrl(source.url)} target="_blank" rel="noreferrer">{source.url}<ExternalLink size={12} /></a></div><Status value={source.adapter === 'unsupported' ? 'unsupported' : source.enabled ? 'ok' : 'unchecked'}>{source.adapter === 'unsupported' ? '等待来源适配' : source.enabled ? '监控已开启' : '监控未开启'}</Status></div>
    <div className="if-source-meta"><span>目标文件夹 <b>{data.folders.find(folder => folder.id === source.folderId)?.name || '尚未指定'}</b></span><span>频率 <b>{source.frequency === 'weekly' ? '每周一次' : '每日一次'}</b></span><span>最近检查 <b>{dateText(source.lastCheckedAt)}</b></span></div>
    <div className="if-scope-grid">{['Q', 'S', 'E', 'M'].map(code => { const scope = source.scopeStatus?.[code]; const enabled = source.scopes.includes(code); return <div className={`if-scope ${enabled ? '' : 'is-disabled'}`} key={code}><div className="if-scope-name"><span className="if-scope-check">{enabled && <Check size={13} aria-label="已启用" />}</span><h3>{code} {SCOPE_NAMES[code]}</h3></div><Status value={enabled ? scope?.status : 'unchecked'}>{enabled ? statusName(scope?.status) : '未选择范围'}</Status><p>最近成功：{dateText(scope?.lastSuccessAt)}</p>{scope?.error && <p className="if-error-text">{scope.error}</p>}{webUrl(scope?.url) && <a href={webUrl(scope?.url)} target="_blank" rel="noreferrer">官方栏目 <ExternalLink size={13} /></a>}</div> })}</div>
    {source.error && <p className="if-source-warning">{source.error}</p>}
    {source.status === 'partial' && <p className="if-source-warning"><Clock3 size={16} />部分范围未检查成功，不能据此判断“没有更新”；原有资料继续保留。</p>}
    <div className="if-actions if-source-actions">{data.canManage && <><Button onClick={() => { void mutate(`check-${source.id}`, 'post', `/sources/${encodeURIComponent(source.id)}/check`, {}, '检查任务已提交，后台会逐类读取官方目录。') }} busy={busy === `check-${source.id}`} disabled={!!busy || source.adapter === 'unsupported'}><RefreshCw size={16} />检查更新</Button><Button primary onClick={() => onImport(source.id)} disabled={!!busy || source.adapter === 'unsupported'}><FolderDown size={16} />批量收录到知识库</Button><Button onClick={() => { void mutate(`monitor-${source.id}`, 'patch', `/sources/${encodeURIComponent(source.id)}`, { enabled: !source.enabled }, source.enabled ? '已暂停监控，原有资料继续保留。' : '监控设置已保存。') }} busy={busy === `monitor-${source.id}`} disabled={!!busy || source.adapter === 'unsupported'}>{source.enabled ? <Pause size={16} /> : <Play size={16} />}{source.enabled ? '暂停监控' : '开启监控'}</Button><SourceSettings source={source} folders={data.folders} busy={busy} mutate={mutate} /></>}<Button onClick={onRuns}>查看运行记录<ArrowRight size={15} /></Button></div>
    <p className="if-caption">监控与个人关注分别设置。目录检查成功仅代表获取清单，原文下载、解析和知识库索引分别记录。</p>
  </section>)}</div>
}

function AddSource({ folders, busy, mutate, onClose }: Pick<Shared, 'busy' | 'mutate'> & { folders: InformationSnapshot['folders']; onClose: () => void }) {
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [folder, setFolder] = useState(''), [frequency, setFrequency] = useState('daily')
  const [scopes, setScopes] = useState(['Q', 'S', 'E', 'M'])
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    const link = webUrl(url)
    if (!link || !/^https?:\/\//i.test(url) || !name.trim() || !scopes.length) { setError('请填写来源名称、完整官方网站地址，并选择至少一个范围。'); return }
    const saved = await mutate('add-source', 'post', '/sources', { name: name.trim(), url: link, folderId: folder || null, frequency, scopes, enabled: false }, '来源已保存；未适配来源不能启用监控。')
    if (saved) onClose()
  }
  return <Modal title="添加信息源" onClose={onClose}><form onSubmit={event => { void submit(event) }}><div className="if-form-grid"><label className="if-field if-full">来源名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如 ICH 官方指导原则" /></label><label className="if-field if-full">官方网站地址<input type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://www.ich.org" /></label><label className="if-field">知识库目标文件夹<select value={folder} onChange={event => setFolder(event.target.value)}><option value="">稍后指定</option>{folders.filter(item => item.writable).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="if-field">检查频率<select value={frequency} onChange={event => setFrequency(event.target.value)}><option value="daily">每日一次</option><option value="weekly">每周一次</option></select></label></div><ScopeChoice scopes={scopes} onChange={setScopes} /><p className="if-caption">本版以 ICH 示例体验操作。其他公开来源仅在本机登记为待适配，不执行抓取。</p>{error && <p className="if-error-text" role="alert">{error}</p>}<div className="if-actions if-modal-actions"><Button onClick={onClose} disabled={!!busy}>取消</Button><button type="submit" className="if-button is-primary" disabled={!!busy}>{busy === 'add-source' && <LoaderCircle size={16} className="if-spin" />}保存来源</button></div></form></Modal>
}

function ScopeChoice({ scopes, onChange, disabled = false }: { scopes: string[]; onChange: (value: string[]) => void; disabled?: boolean }) { return <fieldset className="if-scope-choice"><legend>分类范围</legend>{Object.entries(SCOPE_NAMES).map(([code, name]) => <label key={code} className={scopes.includes(code) ? 'is-selected' : ''}><input type="checkbox" checked={scopes.includes(code)} onChange={event => onChange(event.target.checked ? [...scopes, code] : scopes.filter(item => item !== code))} disabled={disabled} />{code} {name}</label>)}</fieldset> }
function SourceSettings({ source, folders, busy, mutate }: Pick<Shared, 'busy' | 'mutate'> & { source: InformationSource; folders: InformationSnapshot['folders'] }) {
  const [open, setOpen] = useState(false), [folder, setFolder] = useState(source.folderId || ''), [frequency, setFrequency] = useState(source.frequency), [scopes, setScopes] = useState(source.scopes)
  const close = useCallback(() => setOpen(false), [])
  return <><Button onClick={() => { setFolder(source.folderId || ''); setScopes(source.scopes); setFrequency(source.frequency); setOpen(true) }}>来源设置</Button>{open && <Modal title="来源设置" onClose={close}><p className="if-caption">{source.name}</p><div className="if-form-grid"><label className="if-field">知识库目标文件夹<select value={folder} onChange={event => setFolder(event.target.value)}><option value="">尚未指定</option>{folders.filter(item => item.writable).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="if-field">检查频率<select value={frequency} onChange={event => setFrequency(event.target.value)}><option value="daily">每日一次</option><option value="weekly">每周一次</option></select></label></div><ScopeChoice scopes={scopes} onChange={setScopes} /><div className="if-actions if-modal-actions"><Button onClick={close} disabled={!!busy}>取消</Button><Button primary busy={busy === `settings-${source.id}`} disabled={!!busy || !scopes.length} onClick={async () => { if (await mutate(`settings-${source.id}`, 'patch', `/sources/${encodeURIComponent(source.id)}`, { scopes, folderId: folder || null, frequency }, '来源设置已保存。')) close() }}>保存设置</Button></div></Modal>}</>
}

function Dashboard({ data, go }: { data: InformationSnapshot; go: (page: Page) => void }) {
  return <><div className="if-stats"><div><span>待阅情报</span><strong>{data.events.filter(event => !event.read).length}</strong><p>按个人关注显示未读情报</p></div><div><span>已保存资料</span><strong>{data.documents.filter(doc => doc.versions.length > 0).length}</strong><p>原文与解析状态分别记录</p></div><div><span>启用监控</span><strong>{data.sources.filter(source => source.enabled).length}<small> / {data.sources.length}</small></strong><p>团队共享来源</p></div></div><div className="if-dashboard-grid"><section className="if-panel"><div className="if-section-head"><h2>最新情报</h2><Button onClick={() => go('inbox')}>查看全部<ArrowRight size={14} /></Button></div>{data.events.length ? data.events.slice(0, 5).map(event => <div className="if-simple-row" key={event.id}><Inbox size={18} /><div><strong>{event.title}</strong><p>{dateText(event.createdAt)}</p></div>{!event.read && <span className="if-unread-dot" aria-label="未读" />}</div>) : <Empty title="还没有更新记录">来源变化与收录记录会显示在这里。</Empty>}</section><section className="if-panel"><div className="if-section-head"><h2>资料与来源</h2><Radio size={18} /></div>{data.sources.map(source => <div className="if-simple-row" key={source.id}><span className="if-small-logo">{source.adapter === 'ich' ? 'ICH' : '源'}</span><div><strong>{source.name}</strong><p>{source.scopes.join(' / ')} · {dateText(source.lastCheckedAt)}</p></div><Status value={source.status} /></div>)}<Button onClick={() => go('sources')}>管理信息源<ArrowRight size={14} /></Button></section></div></>
}

function DocumentDetail(props: { doc: InformationDocument; onRetry?: () => void }) {
  const { preview } = usePortalContext()
  return <div data-note-title={props.doc.title} data-note-url={props.doc.url}>{preview ? <DemoDocumentDetail {...props} /> : <LiveDocumentDetail {...props} />}</div>
}

function DemoDocumentDetail({ doc, onRetry }: { doc: InformationDocument; onRetry?: () => void }) {
  const [tab, setTab] = useState<'versions' | 'changes'>('versions'), [shown, setShown] = useState(false), [question, setQuestion] = useState(''), [answer, setAnswer] = useState(false)
  return <article className="if-document-detail"><div className="if-detail-overline"><span>{doc.scopes.join(' / ')} · {doc.documentType || '官方资料'}</span><Status value={doc.status} /></div><h2>{doc.title}</h2><p className="if-caption">{doc.format} · {doc.language || '语言待识别'} · 发现于 {dateText(doc.discoveredAt)}</p><a className="if-inline-link" href={webUrl(doc.url)} target="_blank" rel="noreferrer">打开官方来源<ExternalLink size={14} /></a>{doc.error && <div className="if-message is-error"><span>{doc.error}</span>{onRetry && <Button onClick={onRetry}>重试解析 · 演示</Button>}</div>}
    <div className="if-tabs" role="tablist" aria-label="资料详情"><button type="button" role="tab" aria-selected={tab === 'versions'} onClick={() => setTab('versions')}>原文与版本</button><button type="button" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>版本变化</button></div>
    {tab === 'versions' ? <div role="tabpanel" aria-label="原文与版本">{!doc.versions.length ? <div className="if-soft-box"><FileText size={21} /><h3>已发现，尚未收录 · 演示</h3><p>体验批量收录后，演示资料会同步显示归档和解析状态；不会下载真实文件。</p></div> : doc.versions.map(version => <div className="if-version" key={version.id}><div className="if-section-head"><h3>演示采集版 {version.id}</h3><span>{dateText(version.createdAt)}</span></div><div className="if-version-states"><span>解析 <Status value={version.parseStatus} /></span><span>知识库索引 <Status value={version.indexStatus} /></span></div><p className="if-caption">{(version.size / 1024).toFixed(1)} KB · 示例校验标识 <code>{version.sha256}</code></p>{version.error && <p className="if-error-text">{version.error}</p>}<Button onClick={() => setShown(!shown)}><FileText size={15} />{shown ? '收起示例原文' : `查看示例原文 ${version.id}`}</Button></div>)}</div> : <div role="tabpanel" aria-label="版本变化" className="if-soft-box"><h3>{doc.versions.length > 1 ? '版本对比 · 演示文本' : '尚无可对比的版本'}</h3>{doc.versions.length > 1 ? <><div className="if-diff before"><small>采集版 01 · 示例</small><del>此前的正文说明与关联问答，沿用上一版参考条目。</del></div><div className="if-diff after"><small>采集版 02 · 示例</small><span>正文说明调整，增加关联问答并更新参考条目。</span></div><p className="if-caption">用固定示例说明前后变化，未执行真实指南比对或 AI 分析。</p></> : <p>本演示资料尚未保存两个版本。</p>}</div>}
    {shown && <div className="if-soft-box"><h3>{doc.title} · 示例正文</h3><p>此处展示资料阅读入口与版本操作方式。正式接入后显示已采集的官方原文，本版不包含该文件的真实内容。</p></div>}
    <div className="if-demo-qa"><h3>知识问答体验</h3><p className="if-caption">仅展示交互方式，不调用 AI。演示已索引版本：{doc.versions.find(version => version.indexStatus === 'ready')?.id || '暂无'}</p><label className="if-field">围绕这份资料提问<input value={question} onChange={event => { setQuestion(event.target.value); setAnswer(false) }} placeholder="例如：这次更新有哪些需要关注的变化？" maxLength={500} /></label><Button disabled={!question.trim() || !doc.versions.some(version => version.indexStatus === 'ready')} onClick={() => setAnswer(true)}>查看问答示例</Button>{answer && <div className="if-soft-box"><strong>固定演示回答</strong><p>正式功能将依据已索引原文回答“{question}”，并附原文出处。此处没有分析文档，也未生成实际结论。</p></div>}</div>
  </article>
}

function EventInbox({ data, busy, mutate }: Shared) {
  const [selected, setSelected] = useState<string | null>(data.events[0]?.id || null)
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [scope, setScope] = useState('all')
  const [undo, setUndo] = useState<{ id: string; read: boolean } | null>(null)
  const events = data.events.filter(event => (filter !== 'unread' || !event.read) && (filter !== 'later' || data.later.includes(event.id)) && event.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (scope === 'all' || data.documents.find(doc => doc.id === event.documentId)?.scopes.includes(scope)))
  const event = events.find(item => item.id === selected) || events[0]
  const doc = data.documents.find(item => item.id === event?.documentId)
  return <><div className="if-toolbar"><div className="if-segment" aria-label="收件箱筛选">{[['all', '全部记录'], ['unread', '未读'], ['later', '稍后看']].map(([key, label]) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div><label className="if-search"><Search size={16} /><input aria-label="搜索情报" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索编号或标题" /></label><label className="if-field">分类筛选<select value={scope} onChange={event => setScope(event.target.value)}>{['all','Q','S','E','M'].map(code => <option key={code} value={code}>{code === 'all' ? '全部分类' : `${code} ${SCOPE_NAMES[code]}`}</option>)}</select></label></div>
  {undo && <div className="if-message is-notice">阅读状态已更改。<Button onClick={async () => { await mutate('undo', 'post', `/events/${encodeURIComponent(undo.id)}/read`, { read: undo.read }, '已撤销阅读状态修改。'); setUndo(null) }}>撤销</Button></div>}
  <div className="if-browser"><section className="if-browser-list" aria-label="情报列表"><div className="if-list-heading">最近变化<span>{events.length} 条</span></div>{events.length ? events.map(item => <button type="button" key={item.id} className={`if-event-row ${event?.id === item.id ? 'is-selected' : ''}`} onClick={() => setSelected(item.id)}><div className="if-row-meta"><span>{item.kind}</span>{!item.read && <span className="if-unread-dot" aria-label="未读" />}</div><strong>{item.title}</strong><span className="if-caption">{dateText(item.createdAt)} · 来源记录</span></button>) : <Empty title="没有匹配的情报">试试调整分类、阅读状态或搜索关键词。</Empty>}</section>
  <section className="if-browser-detail" aria-label="情报详情">{event ? <>{event.summary && <div className="if-soft-box"><h3>变化详情</h3><p>{event.summary}</p></div>}{doc ? <DocumentDetail key={doc.id} doc={doc} onRetry={data.canManage ? () => { void mutate(`retry-document-${doc.id}`, "post", `/documents/${encodeURIComponent(doc.id)}/retry`, {}, "解析重试任务已提交。") } : undefined} /> : <><h2>{event.title}</h2><p className="if-caption">{dateText(event.createdAt)} · 收录汇总</p></>}
  <div className="if-actions if-source-actions"><Button onClick={async () => { if (await mutate(`read-${event.id}`, 'post', `/events/${encodeURIComponent(event.id)}/read`, { read: !event.read }, event.read ? '已标记为未读。' : '已标记为已读。')) setUndo({ id: event.id, read: event.read }) }} disabled={!!busy}><CheckCheck size={15} />{event.read ? '标记未读' : '标记已读'}</Button><Button onClick={() => { void mutate('later', 'post', `/later/${encodeURIComponent(event.id)}`, {}, '稍后看状态已保存。') }}>{data.later.includes(event.id) ? '移出稍后看' : '稍后看'}</Button>{doc && <Button onClick={() => { void mutate('document-follow', 'put', `/follows/${encodeURIComponent(`document:${doc.id}`)}`, { enabled: !data.follows.includes(`document:${doc.id}`) }, '资料关注已保存。') }}><Bookmark size={15} />{data.follows.includes(`document:${doc.id}`) ? '取消关注' : '关注资料'}</Button>}</div></> : <Empty icon={<Inbox size={30} />} title="选择一条情报">查看来源、版本对比和阅读状态。</Empty>}</section></div></>
}

function Materials({ data, mutate }: Shared) {
  const { preview } = usePortalContext()
  const location = useLocation()
  const folder = new URLSearchParams(location.search).get('folder')

  const [search, setSearch] = useState(''), [scope, setScope] = useState('all'), [selected, setSelected] = useState<string | null>(data.documents[0]?.id || null)
  const [matches, setMatches] = useState<{ query: string; ids: string[]; error?: string }>({ query: '', ids: [] })
  useEffect(() => {
    if (preview || !search.trim()) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => { void searchInformation(search, controller.signal).then(result => {
      if (!controller.signal.aborted) setMatches({ query: search, ids: result.documentIds })
    }).catch(() => { if (!controller.signal.aborted) setMatches({ query: search, ids: [], error: '正文搜索暂不可用，当前仅匹配标题。' }) }) }, 300)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [preview, search])
  const documents = data.documents.filter(doc => (!folder || doc.folderIds.includes(folder)) && (scope === 'all' || doc.scopes.includes(scope)) && (doc.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || (matches.query === search && matches.ids.includes(doc.id))))
  const doc = documents.find(item => item.id === selected) || documents[0]
  return <><div className="if-folder-heading"><Folder size={18} /><h2>{data.folders.find(item => item.id === folder)?.name || "全部资料"}</h2><span className="if-count">{documents.length} 份</span></div><div className="if-toolbar"><div className="if-segment" aria-label="资料分类">{['all', 'Q', 'S', 'E', 'M'].map(code => <button key={code} type="button" aria-pressed={scope === code} onClick={() => setScope(code)}>{code === 'all' ? '全部资料' : `${code} ${SCOPE_NAMES[code]}`}</button>)}</div><label className="if-search"><Search size={16} /><input aria-label="搜索资料" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索资料名称或正文" /></label></div>{matches.query === search && matches.error && <p className="if-error-text" role="alert">{matches.error}</p>}<div className="if-browser"><section className="if-browser-list" aria-label="知识资料列表"><div className="if-list-heading">资料目录<span>{documents.length} 份</span></div>{documents.length ? documents.map(item => <button type="button" key={item.id} className={`if-document-row ${selected === item.id ? 'is-selected' : ''}`} onClick={() => setSelected(item.id)}><FileText size={20} /><div><strong>{item.title}</strong><div className="if-row-meta"><span>{item.scopes.join(' / ')} · {item.format}</span><Status value={item.status} /></div><p>{item.versions.length} 个已保存版本</p></div><ChevronRight size={16} /></button>) : <Empty icon={<Library size={27} />} title="没有符合条件的资料">发现的资料清单与已归档原文分别标记，可按分类和名称查找。</Empty>}</section><section className="if-browser-detail" aria-label="知识资料详情">{doc ? <DocumentDetail key={doc.id} doc={doc} onRetry={data.canManage ? () => { void mutate(`retry-document-${doc.id}`, "post", `/documents/${encodeURIComponent(doc.id)}/retry`, {}, "解析重试任务已提交。") } : undefined} /> : <Empty icon={<FileText size={28} />} title="选择一份资料">查看资料、历史版本与解析状态。</Empty>}</section></div></>
}

function Following({ data, busy, mutate }: Shared & { preview: boolean }) {
  const [note, setNote] = useState(data.note)
  const follow = (id: string, label: string) => <label className="if-follow" key={id}><div><strong>{label}</strong><p>个人关注偏好，不改变团队来源监控</p></div><input type="checkbox" aria-label={`关注 ${label}`} checked={data.follows.includes(id)} disabled={!!busy} onChange={event => { void mutate(`follow-${id}`, 'put', `/follows/${encodeURIComponent(id)}`, { enabled: event.target.checked }, '个人关注已保存。') }} /></label>
  return <div className="if-dashboard-grid"><section className="if-panel"><h2>我关注的资料</h2>{data.documents.filter(doc => data.follows.includes(`document:${doc.id}`)).map(doc => <div className="if-simple-row" key={doc.id}><Bookmark size={18} /><div><strong>{doc.title}</strong><p>{doc.scopes.join(' / ')} · 已发现资料</p></div><Button onClick={() => { void mutate('unfollow', 'put', `/follows/${encodeURIComponent(`document:${doc.id}`)}`, { enabled: false }, '已取消关注资料。') }}>取消关注</Button></div>)}{!data.follows.some(id => id.startsWith('document:')) && <p className="if-caption">在情报详情中关注资料，集中保存在这里。</p>}<label className="if-field if-note">我的研究笔记<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={800} /></label><p className="if-caption">{note.length} / 800 · 个人笔记保存在服务端</p><Button primary onClick={() => { void mutate('note', 'post', '/preferences', { note }, '个人笔记已保存。') }}>保存笔记</Button></section><section className="if-panel"><div className="if-section-head"><h2>提醒与关注偏好</h2><Bell size={21} /></div><label className="if-field">提醒节奏<select value={data.digest} onChange={event => { void mutate('digest', 'post', '/preferences', { digest: event.target.value }, '提醒节奏已保存。') }}>{['每日汇总','即时提醒','暂停提醒'].map(value => <option key={value}>{value}</option>)}</select></label>{Object.entries(SCOPE_NAMES).map(([code, name]) => follow(`scope:${code}`, `${code} ${name}`))}{data.sources.map(source => follow(`source:${source.id}`, source.name))}<label className="if-follow"><div><strong>链接与格式变化</strong><p>默认仅记录，不提醒</p></div><input type="checkbox" checked={data.minor} onChange={event => { void mutate('minor', 'post', '/preferences', { minor: event.target.checked }, '提醒范围已保存。') }} /></label><p className="if-caption">暂停提醒不会停止团队来源监控。提醒在站内收件箱查看；每日汇总按 UTC 日期归集，不发送站外消息。</p></section></div>
}

function ImportFlow({ data, preferredSource, busy, mutate, onRuns }: Shared & { preferredSource?: string; onRuns: () => void }) {
  const location = useLocation()
  const previewSuffix = new URLSearchParams(location.search).get('preview') === '1' ? '&preview=1' : ''
  const sources = data.sources.filter(source => source.adapter !== 'unsupported')
  const [sourceId, setSourceId] = useState(preferredSource || sources[0]?.id || ''), [folderId, setFolderId] = useState(data.folders.find(folder => folder.writable && folder.id === sources.find(source => source.id === preferredSource)?.folderId)?.id || data.folders.find(folder => folder.writable)?.id || '')
  const [newFolder, setNewFolder] = useState('')
  const [scopes, setScopes] = useState(['Q', 'S', 'E', 'M']), [parse, setParse] = useState(true), [step, setStep] = useState(1), [documents, setDocuments] = useState<InformationDocument[]>([]), [selected, setSelected] = useState<string[]>([]), [scanning, setScanning] = useState(false), [error, setError] = useState('')
  if (!data.canManage) return <section className="if-panel"><Empty icon={<ShieldCheck size={30} />} title="需要资料收录权限">批量收录与来源管理由系统管理员或知识库负责人操作，团队成员可以浏览知识资料与关注更新。</Empty></section>
  async function previewList() { setScanning(true); setError(''); setDocuments(data.documents.filter(doc => doc.sourceId === sourceId && doc.scopes.some(scope => scopes.includes(scope)))); setSelected([]); setStep(2); setScanning(false) }
  async function submit() { if (await mutate('create-job', 'post', '/jobs', { sourceId, documentIds: selected, folderId, parse, newFolder: folderId === 'new-folder' ? newFolder : undefined }, '收录任务已创建，后台持续处理，可离开本页后再查看。')) setStep(3) }
  const activeJob = data.jobs.filter(job => job.sourceId === sourceId).at(-1)
  return <><ol className="if-steps">{['选择文件夹与范围', '确认资料清单', '收录任务与结果'].map((label, index) => <li key={label} className={step === index + 1 ? 'is-current' : step > index + 1 ? 'is-complete' : ''} aria-current={step === index + 1 ? 'step' : undefined}><span>{step > index + 1 ? <Check size={15} /> : index + 1}</span>{label}</li>)}</ol>{error && <div className="if-message is-error" role="alert">{error}</div>}<div className="if-import-grid"><section className="if-panel">{step === 1 && <><h2>选择保存位置</h2><div className="if-form-grid"><label className="if-field">信息源<select value={sourceId} onChange={event => setSourceId(event.target.value)}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label><label className="if-field">知识库文件夹<select value={folderId} onChange={event => setFolderId(event.target.value)}><option value="">请选择目标文件夹</option><option value="new-folder" disabled={data.integration.status !== 'ready' && data.integration.status !== 'demo'}>新建知识库文件夹</option>{data.folders.filter(folder => folder.writable).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>{folderId === "new-folder" && <label className="if-field if-full">新文件夹名称<input value={newFolder} maxLength={60} onChange={event => setNewFolder(event.target.value)} placeholder="例如 ICH 资料" /></label>}</div>{!data.folders.some(folder => folder.writable) && <div className="if-soft-box"><Folder size={20} /><h3>尚无可写入的知识库文件夹</h3><p>请先由管理员连接知识库并指定共享文件夹，完成后刷新本页。</p></div>}<ScopeChoice scopes={scopes} onChange={setScopes} /><label className="if-checkline"><input type="checkbox" checked={parse} onChange={event => setParse(event.target.checked)} /><span><strong>保存后建立知识库问答索引</strong><small>原文先保存并提取正文；扫描件会提示需要 OCR。知识库索引失败可单独重试。</small></span></label><div className="if-actions"><Button primary onClick={() => { void previewList() }} busy={scanning} disabled={!sourceId || !folderId || (folderId === "new-folder" && !newFolder.trim()) || !scopes.length || !!busy}>预览收录清单<ArrowRight size={16} /></Button></div><p className="if-caption">清单来自上次成功的官方目录检查，文件数量以实际发现结果为准。首次使用请先在信息源点击检查更新。</p></>}
      {step === 2 && <><div className="if-section-head"><h2>确认收录清单</h2><span className="if-count">已选 {selected.length} / {documents.length}</span></div>{documents.length ? <><label className="if-checkline"><input type="checkbox" aria-label="全选资料" checked={!!documents.length && selected.length === documents.length} onChange={event => setSelected(event.target.checked ? documents.map(doc => doc.id) : [])} />选择当前范围的全部资料</label><div className="if-import-list">{documents.map(doc => <label className="if-import-document" key={doc.id}><input type="checkbox" aria-label={`收录 ${doc.title}`} checked={selected.includes(doc.id)} onChange={event => setSelected(event.target.checked ? [...selected, doc.id] : selected.filter(id => id !== doc.id))} /><FileText size={20} /><div><strong>{doc.title}</strong><p>{doc.scopes.join(' / ')} · {doc.format} · {doc.documentType || '官方资料'}</p></div><Status value={doc.status} /></label>)}</div></> : <Empty title="当前范围没有已发现的资料">请先到信息源执行检查。清单未获取成功时，不会把示例文件当作实际结果。</Empty>}<div className="if-actions"><Button onClick={() => setStep(1)} disabled={!!busy}>上一步</Button><Button primary onClick={() => { void submit() }} busy={busy === 'create-job'} disabled={!selected.length || !folderId || !!busy}>开始批量收录</Button></div></>}
      {step === 3 && <><div className="if-soft-box"><FolderDown size={30} /><h2>任务已提交</h2><p>任务由服务器执行，离开页面不影响采集。原文、解析与知识库索引分别记录，失败项可以单独重试。</p></div>{activeJob && <JobCard key={activeJob.id} job={activeJob} data={data} busy={busy} mutate={mutate} />}<div className="if-actions"><Button primary onClick={onRuns}>查看任务与运行记录<ArrowRight size={16} /></Button>{activeJob && <Link className="if-button" to={`/information/library?folder=${encodeURIComponent(activeJob.folderId)}${previewSuffix}`}>打开目标文件夹<Folder size={15} /></Link>}<Button onClick={() => { setStep(1); setSelected([]) }}>新建收录任务</Button></div></>}
    </section><aside className="if-panel if-import-summary"><span className="if-summary-icon"><Folder size={24} /></span><h2>本次收录</h2><p className="if-folder-path">知识库 / <strong>{(folderId === 'new-folder' ? newFolder || '新文件夹' : data.folders.find(folder => folder.id === folderId)?.name) || '尚未指定'}</strong></p><dl><div><dt>资料来源</dt><dd>{sources.find(source => source.id === sourceId)?.name || '尚未选择'}</dd></div><div><dt>收录范围</dt><dd>{scopes.join(' / ') || '尚未选择'}</dd></div><div><dt>处理方式</dt><dd>{parse ? '保存原文、提取正文并请求索引' : '保存原文和正文，暂不请求索引'}</dd></div>{step > 1 && <div><dt>选中文件</dt><dd>{selected.length} 份</dd></div>}</dl><div className="if-import-rules"><h3>文件保存规则</h3><p><Check size={15} />按原文内容校验，重复文件不会重复存储。</p><p><Check size={15} />不同内容版本分别保留，来源信息可追溯。</p><p><Check size={15} />失败不会显示为成功，解析与知识库状态单独记录。</p></div></aside></div></>
}

function JobCard({ job, data, busy, mutate }: Shared & { job: InformationJob }) {
  const [expanded, setExpanded] = useState(false)
  const percent = job.total ? Math.min(100, Math.round(job.processed / job.total * 100)) : 0
  return <section className="if-job"><div className="if-section-head"><div><h3>{data.sources.find(source => source.id === job.sourceId)?.name || '资料收录任务'}</h3><p className="if-caption">{data.folders.find(folder => folder.id === job.folderId)?.name || '目标文件夹'} · {dateText(job.createdAt)}</p></div><Status value={job.status} /></div><div className="if-job-progress"><span>已处理 {job.processed} / {job.total} 份</span><b>{percent}%</b></div><progress value={job.processed} max={Math.max(job.total, 1)} aria-label="收录处理进度" /><div className="if-job-metrics"><span>原文已保存 <b>{job.saved}</b></span><span>失败 <b>{job.failed}</b></span><span>待处理 <b>{job.pending}</b></span></div>{job.error && <p className="if-error-text">{job.error}</p>}<div className="if-actions"><Button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起逐文件结果' : '逐文件结果'}</Button>{data.canManage && ['running', 'queued', 'pending', 'paused'].includes(job.status) && <Button disabled={!!busy} busy={busy === `job-${job.id}`} onClick={() => { void mutate(`job-${job.id}`, 'post', `/jobs/${encodeURIComponent(job.id)}/control`, { action: job.status === 'paused' ? 'resume' : 'pause' }, '任务控制请求已保存。') }}>{job.status === 'paused' ? '继续收录' : '暂停收录'}</Button>}{data.canManage && job.failed > 0 && !['running', 'queued', 'pending'].includes(job.status) && <Button disabled={!!busy} onClick={() => { void mutate(`retry-${job.id}`, 'post', `/jobs/${encodeURIComponent(job.id)}/control`, { action: 'retry' }, '失败项已重新排队，后台继续处理。') }}>仅重试失败项</Button>}</div>{expanded && <div className="if-job-items">{job.items.map(item => <div key={item.documentId}><strong>{data.documents.find(doc => doc.id === item.documentId)?.title || item.documentId}</strong><Status value={item.status} />{item.error && <p className="if-error-text">{item.error}</p>}</div>)}</div>}</section>
}

function Runs({ data, busy, mutate }: Shared) {
  return <><div className="if-stats if-runtime-stats"><div><span>模型调用</span><strong>{data.cost.modelCalls}</strong><p>{data.cost.message}</p></div><div><span>运行记录</span><strong>{data.runs.length}</strong><p>目录检查与资料收录单独记录</p></div><div><span>待处理失败</span><strong>{data.jobs.reduce((sum, job) => sum + job.failed, 0)}</strong><p>查看逐文件原因后再决定重试</p></div></div><section className="if-panel"><h2>收录任务</h2>{data.jobs.length ? [...data.jobs].reverse().map(job => <JobCard key={job.id} job={job} data={data} busy={busy} mutate={mutate} />) : <Empty icon={<FolderDown size={26} />} title="尚无收录任务">确认官方清单后，后台任务和逐文件结果会显示在这里。</Empty>}</section><section className="if-panel"><h2>来源检查记录</h2>{data.runs.length ? <div className="if-run-list">{[...data.runs].reverse().map(run => <div className="if-run" key={run.id}><span className="if-run-icon"><Activity size={18} /></span><div><strong>{data.sources.find(source => source.id === run.sourceId)?.name || '来源记录'} · {run.kind === 'import' ? '资料收录' : run.kind === 'monitor' ? '定时检查' : '目录检查'}</strong><p>{dateText(run.startedAt)}{run.finishedAt ? ` → ${dateText(run.finishedAt)}` : ''}</p>{run.error && <p className="if-error-text">{run.error}</p>}{run.details?.scopeStatus && <div className="if-actions">{Object.entries(run.details.scopeStatus).map(([code, scope]) => <span key={code}>{code} <Status value={scope.status} />{scope.error && <small className="if-error-text"> {scope.error}</small>}</span>)}</div>}</div><div><Status value={run.status} />{data.canManage && run.kind !== 'import' && <div className="if-actions">{['queued', 'running', 'paused'].includes(run.status) && <Button disabled={!!busy} onClick={() => { void mutate(`check-control-${run.id}`, 'post', `/jobs/${encodeURIComponent(run.id)}/control`, {action:run.status === 'paused' ? 'resume' : 'pause'}, '检查任务状态已保存。') }}>{run.status === 'paused' ? '继续检查' : '暂停检查'}</Button>}{['failed', 'partial'].includes(run.status) && <Button disabled={!!busy} onClick={() => { void mutate(`check-retry-${run.id}`, 'post', `/jobs/${encodeURIComponent(run.id)}/control`, {action:'retry'}, '失败范围已重新排队。') }}>重试检查</Button>}</div>}</div></div>)}</div> : <Empty icon={<Clock3 size={25} />} title="还没有运行记录">来源检查完成后保留结果与失败原因，不会将超时视为没有更新。</Empty>}</section><CostEstimate /><p className="if-caption">以上为服务器保存的实际运行结果。原文收录失败与知识库索引失败分别显示。</p></>
}

function CostEstimate() {
  const [values, setValues] = useState({ updates: 100, questions: 300, initial: 800, inputPrice: 2, outputPrice: 8, embeddingPrice: .5, server: 0 })
  const update = (key: keyof typeof values, value: string) => setValues(current => ({ ...current, [key]: Math.min(100000, Math.max(0, Number(value) || 0)) }))
  const analysis = values.updates * (.05 * values.inputPrice + .002 * values.outputPrice)
  const qa = values.questions * (.008 * values.inputPrice + .001 * values.outputPrice)
  const embedding = (values.updates * .02 + values.questions * .0001) * values.embeddingPrice
  const initial = values.initial * (.02 * values.inputPrice + .001 * values.outputPrice + .02 * values.embeddingPrice)
  const money = (value: number) => `¥${value.toFixed(2)}`
  return <section className="if-panel"><div className="if-section-head"><div><h2>费用测算</h2><p className="if-caption">可修改的示例参数，不是实际账单或供应商现行报价。</p></div><Status>仅计算 · 无模型调用</Status></div><div className="if-dashboard-grid"><div><div className="if-form-grid">{([['updates','每月变化分析次数'],['questions','每月知识问答次数'],['initial','首次处理文档数'],['inputPrice','输入单价（元 / 百万 Token）'],['outputPrice','输出单价（元 / 百万 Token）'],['embeddingPrice','向量单价（元 / 百万 Token）'],['server','服务器等月费（元）']] as const).map(([key, label]) => <label className="if-field" key={key}>{label}<input type="number" min="0" max="100000" step={key.includes('Price') ? '.01' : '1'} value={values[key]} onChange={event => update(key, event.target.value)} /></label>)}</div><p className="if-caption">假设每次变化分析 50k 输入 / 2k 输出，问答 8k 输入 / 1k 输出，首次文档 20k 输入 / 1k 输出。实际 OCR、存储和重试另计。</p></div><div className="if-cost-summary" aria-live="polite"><span>示例每月支出</span><strong>{money(analysis + qa + embedding + values.server)}</strong>{[['变化分析',analysis],['知识问答',qa],['向量处理',embedding],['服务器等',values.server]].map(([label, value]) => <div key={label}><span>{label}</span><b>{money(Number(value))} / 月</b></div>)}<div><span>首次处理与索引</span><b>{money(initial)} · 一次性</b></div><p className="if-caption">公式在本机计算，不发送文档、提示词或价格请求。</p></div></div></section>
}
