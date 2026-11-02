import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { ArrowUpRight, Check, ChevronRight, Clock3, Database, Download, FileText, Folder, FolderDown, FolderOpen, FolderPlus, FolderSearch, Inbox, Library, Link2, LoaderCircle, PanelRight, Pencil, Plus, Radar, RefreshCw, Search, Star, X } from 'lucide-react'
import { usePortalContext } from '../../components/portal/context'
import ApplicationActions from '../../components/application/ApplicationActions'
import { SCOPE_NAMES } from '../information/api'
import SourceManager from './SourceManager'
import KnowledgeFolders from './KnowledgeFolders'
import { getKnowledgeSources, mutateKnowledgeSources, sourceError, type KnowledgeSourceSnapshot, type SourcePaper } from './api'
import './knowledge-sources.css'

type View = 'library' | 'sources' | 'downloads'
type ModalState = { kind: 'new-folder' | 'rename-folder' | 'assign' | 'move' | 'source'; ids?: string[]; folderId?: string }
type Mutation = (method: 'post' | 'patch', path: string, body: unknown, success: string) => Promise<boolean>
const EMPTY: KnowledgeSourceSnapshot = { papers: [], folders: [], sources: [], jobs: [], documents: [], catalogRevision: 0, canManage: false, canOrganize: false, starred: [], integration: { status: 'unavailable', message: '尚未连接知识库。' } }
function safeUrl(value?: string) { if (!value) return undefined; try { const u = new URL(value, window.location.origin); return ['http:', 'https:'].includes(u.protocol) ? u.href : undefined } catch { return undefined } }
const dateText = (v?: string | null) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未提供'
const sizeText = (n?: number) => !n ? '大小未提供' : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const active = (s: string) => ['queued', 'running', 'pending'].includes(s)
function IndexState({ status }: { status: string }) {
  const labels: Record<string, [string, string]> = { ready: ['可问答', 'green'], pending: ['索引处理中', 'blue'], failed: ['索引待重试', 'warn'], not_requested: ['未建问答索引', ''], none: ['未建问答索引', ''] }
  const [label, tone] = labels[status] || ['索引状态待确认', '']
  return <span className={`kso-chip ${tone}`}>{label}</span>
}
function Button({ children, primary, quiet, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; quiet?: boolean }) { return <button type="button" className={`kso-btn${primary ? ' primary' : ''}${quiet ? ' quiet' : ''} ${className}`} {...props}>{children}</button> }

export default function KnowledgeSourceApp() {
  const { preview, user, identityNamespace, applications } = usePortalContext()
  return <Workspace key={identityNamespace || user.id} userName={user.displayName || user.username} preview={preview} allowed={applications.some(a => a.id === 'knowledge-sources' && a.enabled)} />
}

function Workspace({ preview, allowed, userName }: { preview: boolean; allowed: boolean; userName: string }) {
  const [data, setData] = useState<KnowledgeSourceSnapshot | null>(null)
  const [loading, setLoading] = useState(!preview && allowed), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('library'), [folder, setFolder] = useState('all'), [selected, setSelected] = useState(''), [picks, setPicks] = useState<string[]>([])
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [sort, setSort] = useState('recent'), [details, setDetails] = useState(true)
  const [modal, setModal] = useState<ModalState | null>(null)
  const alive = useRef(true), requestId = useRef(0), mutationLock = useRef(false), focusBack = useRef<HTMLElement | null>(null)
  const refresh = useCallback(async () => {
    const id = ++requestId.current
    try { const result = await getKnowledgeSources(); if (alive.current && id === requestId.current) { setData(result); setError('') } }
    catch (e) { if (alive.current && id === requestId.current) setError(sourceError(e)) }
    finally { if (alive.current && id === requestId.current) setLoading(false) }
  }, [])
  useEffect(() => { alive.current = true; if (!preview && allowed) void Promise.resolve().then(() => { if (alive.current) return refresh() }); return () => { alive.current = false; requestId.current += 1 } }, [preview, allowed, refresh])
  const running = data?.jobs.some(j => active(j.status))
  useEffect(() => { if (!running || preview) return; const timer = window.setTimeout(() => { void refresh() }, 2500); return () => window.clearTimeout(timer) }, [running, data, preview, refresh])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 6000); return () => window.clearTimeout(timer) }, [notice])
  const mutate: Mutation = async (method, path, body, success) => {
    if (preview || mutationLock.current) return false
    mutationLock.current = true; setBusy(true); setError('')
    try { await mutateKnowledgeSources(method, path, body); if (!alive.current) return false; await refresh(); if (!alive.current) return false; setNotice(success); return true }
    catch (e) { if (alive.current) setError(sourceError(e)); return false }
    finally { mutationLock.current = false; if (alive.current) setBusy(false) }
  }
  function go(v: View, target = folder) { setView(v); setFolder(target); setSearch(''); setFilter('all'); setPicks([]) }
  const open = (m: ModalState) => { focusBack.current = document.activeElement as HTMLElement; setModal(m) }
  const close = useCallback(() => { if (mutationLock.current) return; setModal(null); window.setTimeout(() => focusBack.current?.isConnected && focusBack.current.focus(), 0) }, [])
  const d = data || EMPTY
  const folderName = (id: string) => d.folders.find(f => f.id === id)?.name || '未指定'
  const folderCount = (id: string) => d.papers.filter(p => p.folderIds.includes(id)).length
  const sourceFolderIds = d.sources.flatMap(s => s.folderId ? [s.folderId] : [])
  const sourceFolders = new Set(sourceFolderIds)
  const unsorted = (p: SourcePaper) => !p.folderIds.some(id => !sourceFolders.has(id))
  const q = search.trim().toLocaleLowerCase()
  const papers = d.papers.filter(p => (folder === 'all' || (folder === 'recent' ? p.saved : folder === 'unsorted' ? unsorted(p) : folder === 'starred' ? d.starred.includes(p.id) : p.folderIds.includes(folder))) && (!q || `${p.title} ${p.code || ''} ${p.sourceName || ''}`.toLocaleLowerCase().includes(q)) && (filter === 'all' || (filter === 'ready' ? p.indexStatus === 'ready' : filter === 'failed' ? p.indexStatus === 'failed' : p.type === filter)))
    .sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title) : (b.createdAt || '').localeCompare(a.createdAt || ''))
  const paper = papers.find(p => p.id === selected) || papers[0]
  const currentFolder = d.folders.find(f => f.id === folder)
  const visiblePicks = picks.filter(id => papers.some(p => p.id === id))
  const source = d.sources.find(s => s.folderId === folder)
  const title = currentFolder?.name || ({ all: '全部论文', recent: '最近下载', unsorted: '待整理', starred: '我的收藏' }[folder] || '全部论文')
  function nav(v: View, f: string, label: string, icon: ReactNode, count?: number) { return <button type="button" className={`kso-nav${view === v && (v !== 'library' || folder === f) ? ' is-active' : ''}`} onClick={() => go(v, f)} aria-current={view === v && (v !== 'library' || folder === f) ? 'page' : undefined}>{icon}<span>{label}</span>{count !== undefined && <small>{count}</small>}</button> }
  async function assignFolder(folderId: string) { if (await mutate('post', '/papers/folders', { paperIds: visiblePicks, folderIds: [folderId], mode: 'add', revision: d.catalogRevision }, `已将所选论文放入「${folderName(folderId)}」，原件保留。`)) setPicks([]) }
  return <div id="knowledge-source-app">
    <a className="kso-skip" href="#kso-content">跳至知识源内容</a>
    <header className="kso-top kso-source-header"><div className="kso-brand"><div className="kso-mark"><FolderSearch aria-hidden="true" /></div><strong>知识源</strong><span>论文与来源管理</span>{preview && <small className="kso-preview">界面预览 · 未连接数据</small>}</div><div className="kso-header-actions"><button type="button" className="kso-header-refresh" aria-label="刷新知识源" title="刷新知识源" onClick={() => { void refresh() }} disabled={busy || loading || preview || !allowed}><RefreshCw aria-hidden="true" /></button><ApplicationActions userName={userName} preview={preview} /></div></header>
    {notice && <div role="status" className="kso-inline-status">{notice}</div>}{error && <div role="alert" className="kso-inline-status kso-inline-error">{error}<Button quiet onClick={() => { void refresh() }} disabled={busy}>重试连接</Button></div>}
    <div className="kso-shell"><aside className="kso-sidebar"><div className="kso-side-group">{nav('library', 'all', '全部论文', <Library />, d.papers.length)}{nav('library', 'recent', '最近下载', <Clock3 />)}{nav('library', 'unsorted', '待整理', <Inbox />, d.papers.filter(unsorted).length)}{nav('library', 'starred', '我的收藏', <Star />, d.papers.filter(p => d.starred.includes(p.id)).length)}</div><div><div className="kso-side-label"><span>论文文件夹</span>{d.canOrganize && <button className="kso-icon-btn" type="button" aria-label="新建文件夹" onClick={() => open({ kind: 'new-folder' })}><Plus /></button>}</div><div className="kso-side-group">{d.folders.map(f => <div key={f.id}>{nav('library', f.id, f.name, sourceFolders.has(f.id) ? <FolderDown /> : <Folder />, folderCount(f.id))}</div>)}</div></div><div className="kso-side-group"><div className="kso-side-label">获取论文</div>{nav('sources', '', '论文搜索源', <Radar />, d.sources.length)}{nav('downloads', '', '下载任务', <Download />, d.jobs.filter(j => active(j.status) || j.status === 'paused').length || undefined)}</div><div className="kso-side-end"><strong><Database />与知识库共用论文</strong>多个文件夹，共用一份原件。<br />来源下载由用户主动启动。</div></aside>
      <main id="kso-content" className="kso-main" aria-busy={loading || busy}>
        {preview ? <Empty title="知识源界面预览">预览不连接知识库。请正常登录后查看真实论文、文件夹和来源下载任务。</Empty> : !allowed ? <Empty title="知识源暂不可用">请返回工作台刷新应用权限，或联系管理员。</Empty> : loading ? <Empty title="正在读取知识库"><LoaderCircle className="if-spin" />正在加载论文、文件夹和来源状态。</Empty> : !data ? <Empty title="知识库尚未连接">{error || '请检查连接后刷新，当前没有可确认的论文清单。'}</Empty> : <>
          {d.integration.status !== 'ready' && <div className="kso-connection" role="status">{d.integration.message}</div>}
          {view === 'sources' ? <SourceManager data={d} busy={busy} mutate={mutate} onAdd={() => open({ kind: 'source' })} onDownloads={() => go('downloads')} /> : view === 'downloads' ? <Downloads data={d} busy={busy} mutate={mutate} go={go} /> : <>
            <div><div className="kso-breadcrumb"><Database />知识库<ChevronRight />{title}</div><div className="kso-head"><div><h1>{title}</h1><p>{folder === 'unsorted' ? '尚未放入主题文件夹的论文，包含仅在下载源文件夹中的资料。' : source ? '来源下载的默认归档位置，也可以继续放入其他主题文件夹。' : '统一管理知识库论文，按主题分类，并随时查看已有原文。'}</p></div><div className="kso-actions">{d.canOrganize && currentFolder && <Button onClick={() => open({ kind: 'rename-folder', folderId: folder })} disabled={busy}><Pencil />重命名</Button>}{d.canManage && <Button primary className="kso-download-cta" onClick={() => go('sources')}><Download /><span><strong>从来源下载</strong><small>搜索官网资料并归档到文件夹</small></span><ChevronRight /></Button>}</div></div></div>
            {source && <div className="kso-source-strip"><div><Link2 /><div><strong>已关联下载源 {source.name}</strong><span> · 下载后自动归入此文件夹，整理时复用原件</span></div></div><Button quiet onClick={() => go('sources')}>管理来源<ArrowUpRight /></Button></div>}
            {folder === 'all' && <KnowledgeFolders folders={d.folders} papers={d.papers} sourceFolderIds={sourceFolderIds} selectedIds={visiblePicks} canOrganize={d.canOrganize} busy={busy} onOpen={id => go('library', id)} onCreate={() => open({ kind: 'new-folder' })} onRename={id => open({ kind: 'rename-folder', folderId: id })} onAssign={id => { void assignFolder(id) }} />}
            <section className="kso-workspace" aria-label="论文文件夹管理器"><div className="kso-toolbar"><label className="kso-search"><Search /><input aria-label="搜索论文" placeholder="搜索标题、指南编号或关键词" value={search} onChange={e => { setSearch(e.target.value); setPicks([]) }} /></label><select className="kso-select" aria-label="筛选资料" value={filter} onChange={e => { setFilter(e.target.value); setPicks([]) }}><option value="all">全部类型与状态</option>{[...new Set(d.papers.map(p => p.type).filter(Boolean))].map(t => <option key={t}>{t}</option>)}<option value="ready">可问答</option><option value="failed">索引待重试</option></select><select className="kso-select" aria-label="论文排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近下载</option><option value="name">按标题排列</option></select><button type="button" className="kso-icon-btn" aria-label={details ? '隐藏论文详情' : '显示论文详情'} aria-pressed={details} onClick={() => setDetails(!details)}><PanelRight /></button></div>
              {visiblePicks.length > 0 && <div className="kso-bulk" role="group" aria-label="批量论文操作"><strong>已选 {visiblePicks.length} 篇</strong>{d.canOrganize && <><Button disabled={busy} onClick={() => open({ kind: 'assign', ids: visiblePicks })}><FolderPlus />放入文件夹</Button>{currentFolder && <Button disabled={busy} onClick={() => open({ kind: 'move', ids: visiblePicks, folderId: folder })}>移动到…</Button>}</>}<Button quiet onClick={() => setPicks([])}>取消选择</Button></div>}
              <div className={`kso-manager${details && paper ? '' : ' no-detail'}`}><div className="kso-list"><table className="kso-table"><thead><tr><th><input type="checkbox" aria-label="全选当前论文" checked={papers.length > 0 && papers.every(p => visiblePicks.includes(p.id))} onChange={e => setPicks(e.target.checked ? papers.map(p => p.id) : [])} /></th><th>论文名称 <span className="kso-small">{papers.length}</span></th><th className="kso-folder-col">所属文件夹</th><th className="kso-status-col">服务器 / 知识库</th></tr></thead><tbody>{papers.map(p => <tr key={p.id} className={paper?.id === p.id ? 'is-current' : ''}><td><input type="checkbox" aria-label={`选择 ${p.title}`} checked={visiblePicks.includes(p.id)} onChange={e => setPicks(e.target.checked ? [...picks, p.id] : picks.filter(id => id !== p.id))} /></td><td><button type="button" className="kso-paper-button" onClick={() => { setSelected(p.id); setDetails(true) }}><span className="kso-doc-icon"><FileText /></span><span><span className="kso-paper-title">{p.title}{d.starred.includes(p.id) && ' ☆'}</span><span className="kso-paper-sub">{p.sourceName || '知识库已有资料'} · {p.type || '论文资料'}{p.size ? ` · ${sizeText(p.size)}` : ''}{p.createdAt ? ` · ${dateText(p.createdAt)}` : ''}</span></span></button></td><td className="kso-folder-col"><div className="kso-folders-cell">{p.folderIds.length ? p.folderIds.map(id => <span key={id} className="kso-chip">{folderName(id)}</span>) : <span className="kso-small">未分配文件夹</span>}</div></td><td><div className="kso-status"><span className="kso-small"><Check />{p.saved ? '原件已保存' : '知识库资料'}</span><IndexState status={p.indexStatus} /></div></td></tr>)}</tbody></table>{!papers.length && <Empty title={currentFolder && !search ? '这个文件夹还是空的' : d.papers.length ? '没有匹配的论文' : '还没有已保存的论文'}>{currentFolder && !search ? '从已有论文中勾选资料，再放入这个文件夹；也可以从来源下载。' : d.papers.length ? '调整搜索或分类条件，也可从全部论文重新选择。' : '已有知识库论文会显示在这里，也可以添加来源并下载到服务器。'}<div className="kso-actions kso-empty-actions">{d.papers.length > 0 && <Button onClick={() => { go('library', 'all'); if (currentFolder) setNotice(`勾选论文后，可在文件夹卡片中直接放入「${currentFolder.name}」。`) }}>从全部论文选择</Button>}{d.canManage && <Button primary onClick={() => go('sources')}><Download />从来源下载</Button>}</div></Empty>}</div>{details && paper && <Inspector paper={paper} data={d} busy={busy} onClose={() => setDetails(false)} folder={folder} open={open} mutate={mutate} />}</div><div className="kso-list-footer"><span>{papers.length} 篇唯一论文 · 多个文件夹共用服务器原件</span><span>读取自知识库与服务器归档</span></div></section>
          </>}
        </>}
      </main></div>
    <footer className="kso-app-footer"><span><Database aria-hidden="true" />与知识库共用论文 · 来源下载由你启动</span><span>迈博药业 · 数字化工作空间</span></footer>
    {modal && data && <Dialog key={`${modal.kind}:${modal.folderId || ''}`} modal={modal} data={d} busy={busy} remoteError={error} mutate={mutate} onClose={close} onDone={() => { setModal(null); setPicks([]) }} />}
  </div>
}

function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="kso-empty"><FolderOpen /><h3>{title}</h3><div>{children}</div></div> }

function Inspector({ paper: p, data, busy, folder, onClose, open, mutate }: { paper: SourcePaper; data: KnowledgeSourceSnapshot; busy: boolean; folder: string; onClose: () => void; open: (m: ModalState) => void; mutate: Mutation }) {
  const original = safeUrl(p.originalUrl), kb = safeUrl(p.kbUrl)
  return <aside className="kso-inspector" aria-label="论文详情"><div className="kso-inspector-label">论文详情<button type="button" className="kso-icon-btn" aria-label="关闭详情" onClick={onClose}><X /></button></div><div><div className="kso-inspector-icon"><FileText /></div><h2>{p.title}</h2><p>{p.code || p.type || '知识库论文'}</p><div className="kso-actions" style={{ marginTop: 10 }}>{original ? <a className="kso-btn" href={original} target="_blank" rel="noreferrer"><FileText />查看原文</a> : kb ? <a className="kso-btn" href={kb} target="_blank" rel="noreferrer">在知识库阅读<ArrowUpRight /></a> : <span className="kso-small">原文入口暂不可用</span>}<button type="button" className="kso-icon-btn" aria-label={data.starred.includes(p.id) ? '取消收藏论文' : '收藏论文'} disabled={busy} onClick={() => { void mutate('post', '/stars', { paperId: p.id, enabled: !data.starred.includes(p.id) }, '个人收藏已保存。') }}><Star fill={data.starred.includes(p.id) ? 'currentColor' : 'none'} /></button></div></div><div className="kso-inspector-section"><h3>文件信息</h3><dl><dt>下载来源</dt><dd>{p.sourceName || '知识库已有资料'}</dd><dt>文件大小</dt><dd>{sizeText(p.size)}</dd><dt>收录日期</dt><dd>{dateText(p.createdAt)}</dd><dt>服务器</dt><dd>{p.saved ? <span className="kso-chip green">原件已保存</span> : '知识库已有资料'}</dd><dt>问答状态</dt><dd><IndexState status={p.indexStatus} /></dd></dl>{p.error && <p className="kso-error">{p.error}</p>}{p.indexStatus !== 'ready' && p.documentId && data.canManage && <Button disabled={busy} onClick={() => { void mutate('post', `/documents/${encodeURIComponent(p.documentId!)}/retry`, {}, '解析与索引重试任务已提交。') }}>{p.indexStatus === 'failed' ? '重试问答索引' : '建立问答索引'}</Button>}{kb && <a className="kso-btn" href={kb} target="_blank" rel="noreferrer">在知识库查看<ArrowUpRight /></a>}</div><div className="kso-inspector-section"><h3>所属文件夹</h3><div className="kso-folders-cell">{p.folderIds.map(id => <span key={id} className="kso-folder-tag"><Folder />{data.folders.find(f => f.id === id)?.name || '未指定'}</span>)}</div>{data.canOrganize && <><Button disabled={busy} onClick={() => open({ kind: 'assign', ids: [p.id] })}><FolderPlus />放入文件夹</Button>{p.folderIds.includes(folder) && <Button quiet disabled={busy} onClick={() => { void mutate('post', '/papers/folders', { paperIds: [p.id], folderIds: [], fromFolderId: folder, mode: 'remove', revision: data.catalogRevision }, '已从当前文件夹移除，论文原件保留。') }}>从当前文件夹移除</Button>}</>}<div className="kso-note"><Link2 />同一论文可以加入多个文件夹，不复制服务器原件。</div></div></aside>
}

function Downloads({ data, busy, mutate, go }: { data: KnowledgeSourceSnapshot; busy: boolean; mutate: Mutation; go: (v: View, f?: string) => void }) {
  return <><div className="kso-head"><div><div className="kso-breadcrumb">获取论文<ChevronRight />任务记录</div><h1>下载任务</h1><p>离开页面后由服务器继续，原件与索引状态分别记录。</p></div><Button primary onClick={() => go('sources')}><Download />从来源下载</Button></div>{[...data.jobs].reverse().map(j => <section key={j.id} className="kso-job"><div className="kso-job-head"><div><h2>{data.sources.find(s => s.id === j.sourceId)?.name || '来源任务'} · {j.kind === 'check' ? '目录检查' : '论文下载'}</h2><p>{dateText(j.createdAt)} · {data.folders.find(f => f.id === j.folderId)?.name || '默认接收文件夹'}</p></div><span className={`kso-chip ${j.failed ? 'warn' : active(j.status) ? 'blue' : 'green'}`}>{{ running: '执行中', queued: '等待执行', pending: '等待执行', paused: '已暂停', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' }[j.status] || j.status}</span></div><div className="kso-job-counts"><span>已处理<strong>{j.processed} / {j.total}</strong></span>{j.kind !== 'check' && <span>原件已保存<strong>{j.saved}</strong></span>}<span>失败<strong>{j.failed}</strong></span></div><div className="kso-progress" role="progressbar" aria-label="任务进度" aria-valuenow={j.processed} aria-valuemin={0} aria-valuemax={Math.max(j.total, 1)}><span style={{ width: `${j.total ? j.processed / j.total * 100 : 0}%` }} /></div>{j.error && <p className="kso-error">{j.error}</p>}<details><summary>逐文件结果</summary>{j.items.map((item, n) => <div className="kso-job-row" key={item.documentId || n}><div><strong>{data.documents.find(d => d.id === item.documentId)?.title || (item as unknown as { scope?: string }).scope || '目录范围'}</strong>{item.error && <small className="kso-error">{item.error}</small>}</div><span className="kso-chip">{{ saved: '已保存', failed: '失败', pending: '等待', skipped: '已有复用' }[item.status] || item.status}</span></div>)}</details><div className="kso-actions">{j.kind !== 'check' && <Button primary onClick={() => go('library', j.folderId)}><FolderOpen />查看目标文件夹</Button>}{data.canManage && <>{(active(j.status) || j.status === 'paused') && <Button disabled={busy} onClick={() => { void mutate('post', `/jobs/${encodeURIComponent(j.id)}/control`, { action: j.status === 'paused' ? 'resume' : 'pause' }, '任务状态已保存。') }}>{j.status === 'paused' ? '继续执行' : '暂停任务'}</Button>}{j.failed > 0 && !active(j.status) && <Button disabled={busy} onClick={() => { void mutate('post', `/jobs/${encodeURIComponent(j.id)}/control`, { action: 'retry' }, '仅失败项已重新排队。') }}><RefreshCw />仅重试失败项</Button>}</>}</div></section>)}{!data.jobs.length && <Empty title="还没有下载任务">从“论文搜索源”刷新清单，确认后开始下载。</Empty>}</>
}

function Dialog({ modal, data, busy, remoteError, mutate, onClose, onDone }: { modal: ModalState; data: KnowledgeSourceSnapshot; busy: boolean; remoteError: string; mutate: Mutation; onClose: () => void; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [revision] = useState(data.catalogRevision)
  const [name, setName] = useState(modal.folderId ? data.folders.find(f => f.id === modal.folderId)?.name || '' : ''), [url, setUrl] = useState('')
  const [destinations, setDestinations] = useState<string[]>([]), [scopes, setScopes] = useState(['Q', 'S', 'E', 'M']), [localError, setLocalError] = useState('')
  useEffect(() => { const previous = document.activeElement as HTMLElement; box.current?.querySelector<HTMLElement>('input,select,button')?.focus(); return () => { if (previous?.isConnected) previous.focus() } }, [])
  const titles = { 'new-folder': '新建论文文件夹', 'rename-folder': '重命名文件夹', assign: '放入论文文件夹', move: '移动到文件夹', source: '添加论文搜索源' }
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocalError('')
    if (busy) return
    let ok = false
    if (modal.kind === 'new-folder' || modal.kind === 'rename-folder') {
      if (!name.trim()) return setLocalError('请填写文件夹名称。')
      ok = await mutate(modal.kind === 'new-folder' ? 'post' : 'patch', modal.kind === 'new-folder' ? '/folders' : `/folders/${encodeURIComponent(modal.folderId!)}`, { name: name.trim(), revision }, '文件夹已保存。')
    } else if (modal.kind === 'assign' || modal.kind === 'move') {
      if (!destinations.length) return setLocalError('请选择目标文件夹。')
      ok = await mutate('post', '/papers/folders', { paperIds: modal.ids, folderIds: destinations, fromFolderId: modal.folderId, mode: modal.kind === 'move' ? 'move' : 'add', revision }, '论文分类已保存，共用原件。')
    } else if (modal.kind === 'source') {
      let parsed: URL
      try { parsed = new URL(url) } catch { return setLocalError('请填写有效的 HTTPS 来源地址。') }
      if (!name.trim() || parsed.protocol !== 'https:' || !scopes.length) return setLocalError('请填写名称、HTTPS 地址，并选择范围。')
      ok = await mutate('post', '/sources', { name: name.trim(), url: parsed.href, scopes, enabled: false }, '来源已保存，默认使用同名文件夹。其他来源适配后才能下载。')
    }
    if (ok) onDone()
  }
  return <div className="kso-dialog-layer" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) onClose()
    if (event.key === 'Tab') {
      const nodes = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || [])
      const first = nodes[0], last = nodes.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}><div ref={box} className="kso-dialog" role="dialog" aria-modal="true" aria-labelledby="kso-dialog-title"><form onSubmit={event => { void submit(event) }}>
    <div className="kso-dialog-head"><h2 id="kso-dialog-title">{titles[modal.kind]}</h2><button type="button" className="kso-icon-btn" aria-label="关闭窗口" onClick={onClose} disabled={busy}><X /></button></div>
    <div className="kso-dialog-body">
      {(modal.kind === 'new-folder' || modal.kind === 'rename-folder' || modal.kind === 'source') && <label className="kso-field">{modal.kind === 'source' ? '来源名称' : '文件夹名称'}<input value={name} onChange={event => setName(event.target.value)} maxLength={60} required placeholder={modal.kind === 'source' ? '例如 ICH' : '例如 稳定性研究'} /></label>}
      {modal.kind === 'source' && <><label className="kso-field">官方网站或栏目地址<input type="url" value={url} onChange={event => setUrl(event.target.value)} required placeholder="https://www.ich.org/page/quality-guidelines" /></label><div className="kso-scope-options">{Object.entries(SCOPE_NAMES).map(([key, value]) => <label key={key} className="kso-check kso-scope"><input type="checkbox" checked={scopes.includes(key)} onChange={event => setScopes(event.target.checked ? [...scopes, key] : scopes.filter(code => code !== key))} /><span>{key} {value}</span></label>)}</div><div className="kso-note">默认创建或复用同名论文文件夹。下载由你主动启动，历史监控保持关闭。当前仅 ICH 已适配。</div></>}
      {(modal.kind === 'assign' || modal.kind === 'move') && <><p className="kso-small">已选择 {modal.ids?.length || 0} 篇。{modal.kind === 'move' ? `将从「${data.folders.find(f => f.id === modal.folderId)?.name}」移出，保留其他分类。` : '保留已有文件夹关联，不复制服务器原件。'}</p><div className="kso-folder-options">{data.folders.filter(f => f.id !== modal.folderId).map(f => <label className="kso-folder-option" key={f.id}><input type={modal.kind === 'move' ? 'radio' : 'checkbox'} name="destination" checked={destinations.includes(f.id)} onChange={event => setDestinations(modal.kind === 'move' ? [f.id] : event.target.checked ? [...destinations, f.id] : destinations.filter(id => id !== f.id))} /><Folder /><span>{f.name}</span><small>{data.papers.filter(p => p.folderIds.includes(f.id)).length} 篇</small></label>)}</div>{!data.folders.length && <p className="kso-small">请先返回列表新建文件夹。</p>}</>}
      {(localError || remoteError) && <p role="alert" className="kso-error">{localError || remoteError}</p>}
    </div>
    <div className="kso-dialog-foot"><Button disabled={busy} onClick={onClose}>取消</Button><button type="submit" className="kso-btn primary" disabled={busy}>{busy && <LoaderCircle className="if-spin" />}{modal.kind === 'source' ? '保存来源' : '确认保存'}</button></div>
  </form></div></div>
}
