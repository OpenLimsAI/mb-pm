import { useId, useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Folder, ListChecks, Plus, Radar, RefreshCw, Search, Settings2 } from 'lucide-react'
import { SCOPE_NAMES, type InformationSource } from '../information/api'
import type { KnowledgeSourceSnapshot, SourceDocument } from './api'
import './source-catalog.css'

type Mutation = (method: 'post' | 'patch', path: string, body: unknown, success: string) => Promise<boolean>
interface Props { data: KnowledgeSourceSnapshot; busy: boolean; mutate: Mutation; onAdd: () => void; onDownloads: () => void }
const running = (status: string) => ['queued', 'running', 'pending'].includes(status)
const dateText = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未搜索'
const saved = (document: SourceDocument) => document.versions.length > 0
const officialUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined } catch { return undefined } }
const PAGE_SIZE = 25

export default function SourceManager({ data, busy, mutate, onAdd, onDownloads }: Props) {
  return <>
    <div className="kso-head"><div><div className="kso-breadcrumb">获取论文<ChevronRight />来源管理</div><h1>从来源下载</h1><p>搜索来源中的官方资料，选择后下载到服务器，再归入论文文件夹。</p></div>{data.canManage && <button type="button" className="kso-btn" onClick={onAdd}><Plus />添加搜索源</button>}</div>
    {data.sources.map(source => <SourceSection key={`${source.id}:${source.folderId}:${source.scopes.join(',')}`} {...{ source, data, busy, mutate, onDownloads }} />)}
    {!data.sources.length && <div className="kso-empty"><Radar /><h3>先添加一个论文搜索源</h3><p>添加 ICH 官网来源后，在此页搜索、选择和下载，默认归入同名文件夹。</p>{data.canManage && <button type="button" className="kso-btn primary" onClick={onAdd}><Plus />添加搜索源</button>}</div>}
    <p className="kso-bottom-caption">再次搜索只更新目录，不自动下载或建立索引。其他网站完成适配后才能执行搜索与下载。</p>
  </>
}

function SourceSection({ source, data, busy, mutate, onDownloads }: Omit<Props, 'onAdd'> & { source: InformationSource }) {
  const [scopes, setScopes] = useState(source.scopes), [folder, setFolder] = useState(source.folderId || '')
  const supported = source.adapter === 'ich'
  const checking = data.jobs.some(job => job.sourceId === source.id && job.kind === 'check' && running(job.status))
  const unfinished = data.jobs.find(job => job.sourceId === source.id && (running(job.status) || job.status === 'paused'))
  const locked = !!unfinished
  const docs = data.documents.filter(doc => doc.sourceId === source.id && doc.scopes.some(scope => source.scopes.includes(scope)))
  const destination = data.folders.find(f => f.id === source.folderId)?.name || source.name
  const dirty = folder !== (source.folderId || '') || [...scopes].sort().join(',') !== [...source.scopes].sort().join(',')
  const failures = Object.entries(source.scopeStatus || {}).filter(([code, state]) => source.scopes.includes(code) && ['error', 'failed'].includes(state.status))
  return <section className="kso-source-section" aria-label={`${source.name}来源与论文`}>
    <div className="kso-source-card">
      <div className="kso-source-card-head"><div className="kso-source-logo">{supported ? 'ICH' : <Radar />}</div><div><h2>{source.name}</h2><a href={officialUrl(source.url)} target="_blank" rel="noreferrer">{source.url}<ExternalLink /></a></div><span className={`kso-chip ${supported ? 'green' : 'warn'}`}>{supported ? '已支持下载' : '等待适配'}</span></div>
      <div className="kso-source-searchbar"><div><span><Folder />下载后归入 <strong>{destination}</strong></span><small>最近搜索：{dateText(source.lastCheckedAt)}</small></div>{data.canManage && supported && <button type="button" className="kso-btn primary kso-search-again" disabled={busy || locked} onClick={() => { void mutate('post', `/sources/${encodeURIComponent(source.id)}/check`, {}, '已开始再次搜索，完成后会更新下方清单并标记新增资料。') }}><RefreshCw className={checking ? 'kso-spin' : undefined} />{checking ? '正在搜索…' : locked ? '等待当前任务结束' : '再次搜索'}</button>}</div>
      {locked && <div className="kso-source-active-task" role="status"><span>{unfinished.status === 'paused' ? '此来源有已暂停任务，请先继续处理。' : '此来源正在处理任务，完成后可再次搜索或提交下载。'}已选资料会保留。</span><button type="button" className="kso-btn" onClick={onDownloads}>查看当前任务</button></div>}
      <details className="kso-source-settings"><summary><Settings2 />来源设置<span>{source.scopes.join(' / ')} · {destination}{dirty ? ' · 有未保存修改' : ''}</span><ChevronDown /></summary><div className="kso-source-settings-body">
        <div className="kso-source-fields"><label className="kso-field">默认论文文件夹<select value={folder} disabled={!data.canManage || busy || locked} onChange={event => setFolder(event.target.value)}><option value="">使用来源同名文件夹</option>{data.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><small>原件保存后归入此文件夹，也可以继续按主题整理。</small></label><div className="kso-field"><span>目录检查</span><div className="kso-note">搜索范围以已保存的设置为准。首次建立目录基线不标 NEW；NEW 表示最近一次成功搜索新发现，下次成功搜索会刷新标记。</div></div></div>
        {supported && <div className="kso-field"><span>ICH 搜索范围</span><div className="kso-scope-options">{Object.entries(SCOPE_NAMES).map(([code, name]) => <label key={code} className="kso-check kso-scope"><input type="checkbox" checked={scopes.includes(code)} disabled={!data.canManage || busy || locked} onChange={event => setScopes(event.target.checked ? [...scopes, code] : scopes.filter(value => value !== code))} /><span><strong>{code}</strong><small>{name}</small></span></label>)}</div></div>}
        {data.canManage && <div className="kso-source-settings-actions"><small>{dirty ? '保存设置后，再次搜索会使用新的范围。' : '来源设置已保存'}</small><button type="button" className="kso-btn" disabled={busy || locked || !scopes.length || !dirty} onClick={() => { void mutate('patch', `/sources/${encodeURIComponent(source.id)}`, { folderId: folder || null, scopes }, '来源设置已保存。') }}>保存设置</button></div>}
      </div></details>
      {failures.length > 0 && <div className="kso-catalog-warning" role="status">{failures.map(([code]) => code).join(' / ')} 范围搜索未成功，保留上次清单；可再次搜索重试。</div>}
      {source.error && !failures.length && <p className="kso-error">{source.error}</p>}
    </div>
    {supported ? <SourceCatalog {...{ source, docs, data, busy, checking, locked, mutate, onDownloads, destination }} /> : <div className="kso-empty"><Radar /><h3>该来源等待适配</h3><p>已保留来源设置，完成适配后才可搜索和下载。</p></div>}
  </section>
}

function SourceCatalog({ source, docs, data, busy, checking, locked, mutate, onDownloads, destination }: Omit<Props, 'onAdd'> & { source: InformationSource; docs: SourceDocument[]; checking: boolean; locked: boolean; destination: string }) {
  const selectionHintId = useId()
  const [query, setQuery] = useState(''), [scope, setScope] = useState('all'), [status, setStatus] = useState('pending'), [page, setPage] = useState(1)
  const [chosen, setChosen] = useState<string[]>([]), [parse, setParse] = useState(true)
  const needle = query.trim().toLocaleLowerCase()
  const filtered = docs.filter(doc => (!needle || `${doc.title} ${doc.documentType} ${doc.officialStatus || ''}`.toLocaleLowerCase().includes(needle)) && (scope === 'all' || doc.scopes.includes(scope)) && (status === 'all' || (status === 'new' ? doc.isNew : status === 'saved' ? saved(doc) : !saved(doc))))
    .sort((a, b) => Number(!!b.isNew) - Number(!!a.isNew) || a.title.localeCompare(b.title))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), currentPage = Math.min(page, pages)
  const rows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const selected = chosen.filter(id => docs.some(doc => doc.id === id)), newCount = docs.filter(doc => doc.isNew).length
  const allPageSelected = rows.length > 0 && rows.every(doc => selected.includes(doc.id))
  const categoryRows = scope === 'all' ? [] : filtered
  const allCategorySelected = categoryRows.length > 0 && categoryRows.every(doc => selected.includes(doc.id))
  const categoryHint = scope === 'all' ? '选择分类后可跨页全选' : `${scope} ${SCOPE_NAMES[scope] || scope} · 当前筛选 ${categoryRows.length} 份（含全部分页）`
  const toggle = (id: string, checked: boolean) => setChosen(checked ? [...new Set([...chosen, id])] : chosen.filter(value => value !== id))
  async function download() {
    if (!selected.length || busy || locked || !data.canManage) return
    if (await mutate('post', '/jobs', { sourceId: source.id, documentIds: selected, folderId: source.folderId || undefined, parse }, '下载任务已提交，原件与索引结果可在下载任务查看。')) setChosen([])
  }
  return <section className="kso-catalog" aria-label={`${source.name}可下载论文`} aria-busy={checking}>
    <header className="kso-catalog-heading"><div><h2>可下载论文 <span>{docs.length} 份</span></h2><p>未下载 {docs.filter(doc => !saved(doc)).length} 份 · 已保存 {docs.filter(saved).length} 份</p></div><button type="button" className={`kso-new-filter${status === 'new' ? ' is-active' : ''}`} aria-pressed={status === 'new'} disabled={!newCount} onClick={() => { setStatus(status === 'new' ? 'pending' : 'new'); setQuery(''); setScope('all'); setPage(1) }}><span className="kso-new-badge">NEW</span>新增 {newCount} 份</button></header>
    <div className="kso-catalog-tools"><label className="kso-search"><Search /><input aria-label={`筛选${source.name}已发现论文`} placeholder="筛选当前清单：标题、编号或关键词" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /></label><select className="kso-select" aria-label={`${source.name}下载状态`} value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}><option value="pending">未下载</option><option value="all">全部资料</option><option value="saved">已保存</option><option value="new">新增 NEW</option></select></div>
    <div className="kso-catalog-scopes" role="group" aria-label={`${source.name}分类筛选`}>{[['all', '全部分类'], ...source.scopes.map(code => [code, `${code} ${SCOPE_NAMES[code] || code}`])].map(([code, label]) => <button key={code} type="button" aria-pressed={scope === code} onClick={() => { setScope(code); setPage(1) }}>{label}</button>)}<span>{checking ? '正在更新官网清单，现有结果仍可查看' : '新增项优先显示'}</span></div>
    {data.canManage && (rows.length > 0 || selected.length > 0) && <div className="kso-catalog-selectbar"><label className="kso-check"><input type="checkbox" aria-label={`全选${source.name}本页论文`} checked={allPageSelected} disabled={busy || !rows.length} onChange={event => setChosen(event.target.checked ? [...new Set([...chosen, ...rows.map(doc => doc.id)])] : chosen.filter(id => !rows.some(doc => doc.id === id)))} />全选本页</label><button type="button" className="kso-btn kso-catalog-select-category" aria-describedby={selectionHintId} disabled={busy || !categoryRows.length || allCategorySelected} onClick={() => setChosen([...new Set([...chosen, ...categoryRows.map(doc => doc.id)])])}>{allCategorySelected ? <Check /> : <ListChecks />}全选本类</button><span id={selectionHintId}>{categoryHint} · 本页 {rows.length} 份 · 已选 {selected.length} 份</span>{selected.length > 0 && <button type="button" className="kso-btn quiet" onClick={() => setChosen([])}>清空选择</button>}</div>}
    <div className="kso-catalog-results">{rows.map(doc => <article className={`kso-catalog-row${doc.isNew ? ' is-new' : ''}${selected.includes(doc.id) ? ' is-selected' : ''}`} key={doc.id}>
      <label className="kso-catalog-document"><input type="checkbox" aria-label={`选择 ${doc.title}`} checked={selected.includes(doc.id)} disabled={!data.canManage || busy} onChange={event => toggle(doc.id, event.target.checked)} /><span><strong>{doc.title}{doc.isNew && <span className="kso-new-badge" aria-label="新发现">NEW</span>}</strong><small>{doc.scopes.join(' / ')} · {doc.documentType || '官方资料'} · {doc.officialStatus || '官方状态未标注'}</small></span></label>
      <div className="kso-catalog-row-meta"><span className={`kso-chip${saved(doc) ? ' green' : ''}`}>{saved(doc) ? <><Check />原件已保存</> : '未下载'}</span>{officialUrl(doc.url) && <a href={officialUrl(doc.url)} target="_blank" rel="noreferrer">官网原文<ExternalLink /></a>}</div>
    </article>)}</div>
    {!rows.length && <div className="kso-catalog-empty"><Search /><h3>{!docs.length ? '还没有搜索结果' : '没有匹配的资料'}</h3><p>{!docs.length ? '点击上方“再次搜索”，完成后清单会直接显示在这里。' : status === 'new' ? '当前范围未发现新增资料，可切换查看全部清单。' : '调整分类或关键词，也可以切换查看已保存的资料。'}</p></div>}
    {filtered.length > PAGE_SIZE && <div className="kso-catalog-pagination"><span>共 {filtered.length} 份 · 第 {currentPage} / {pages} 页</span><button type="button" className="kso-btn" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft />上一页</button><button type="button" className="kso-btn" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页<ChevronRight /></button></div>}
    <footer className="kso-catalog-download"><div><strong>已选 {selected.length} 份 <ArrowRight />{destination}</strong><small>先保存服务器原件，已有文件会校验并复用。</small>{data.canManage && <label className="kso-check"><input type="checkbox" checked={parse} disabled={busy} onChange={event => setParse(event.target.checked)} />下载后加入知识库并建立问答索引</label>}</div><div className="kso-actions"><button type="button" className="kso-btn" onClick={onDownloads}>查看下载任务</button>{data.canManage && <button type="button" className="kso-btn primary kso-catalog-submit" disabled={busy || locked || !selected.length} onClick={() => { void download() }}><Download />下载所选{selected.length > 0 ? `（${selected.length}）` : ''}</button>}</div></footer>
  </section>
}
