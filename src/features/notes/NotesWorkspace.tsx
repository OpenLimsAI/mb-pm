import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, FileText, FolderOpen, Link2, LoaderCircle, NotebookPen, PencilLine, Plus, Radio, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import type { NotesClient, NoteSource, PersonalNote } from './client'
import { noteSourceNames } from './client'
import type { NoteDraft } from './draft'
import NoteEditor from './NoteEditor'
import { newNote } from './draft'
import './notes.css'

export default function NotesWorkspace({ client, mode = 'embedded', userName }: { client: NotesClient; mode?: 'app' | 'embedded'; userName?: string }) {
  const [items, setItems] = useState<PersonalNote[]>([]), [total, setTotal] = useState(0), [search, setSearch] = useState(''), [source, setSource] = useState<NoteSource | ''>(''), [trashed, setTrashed] = useState(false)
  const [offset, setOffset] = useState(0), [reload, setReload] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<PersonalNote | NoteDraft | null>(null), [busy, setBusy] = useState(false), [undo, setUndo] = useState<PersonalNote | null>(null)
  const request = useRef(0), currentClient = useRef(client)
  useEffect(() => {
    const token = ++request.current
    let active = true
    currentClient.current = client
    const timer = setTimeout(() => {
      setLoading(true); setError('')
      client.list({ search, sourceApp: source || undefined, trashed, offset }).then(result => {
        if (!active || request.current !== token) return
        setItems(previous => offset ? [...previous, ...result.items.filter(note => !previous.some(old => old.id === note.id))] : result.items); setTotal(result.total)
      }).catch(reason => { if (active && request.current === token) setError(reason instanceof Error ? reason.message : '笔记读取失败，请重试。') }).finally(() => { if (active && request.current === token) setLoading(false) })
    }, search ? 200 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [client, search, source, trashed, offset, reload])
  const refresh = () => { setOffset(0); setReload(value => value + 1) }
  function filter(action: () => void) { request.current++; setItems([]); setTotal(0); setOffset(0); setLoading(true); action() }
  async function move(note: PersonalNote, restore: boolean) {
    if (busy) return
    const token = currentClient.current
    setBusy(true); setError('')
    try {
      const saved = restore ? await client.restore(note) : await client.trash(note)
      if (token !== currentClient.current) return
      setUndo(restore ? null : saved); setNotice(restore ? '笔记已恢复。' : '笔记已移至回收站。'); refresh()
    } catch (reason) { if (token === currentClient.current) setError(reason instanceof Error ? reason.message : '操作未完成，请重试。') }
    finally { if (token === currentClient.current) setBusy(false) }
  }
  const app = mode === 'app'
  const heading = trashed ? '回收站' : source ? noteSourceNames[source] : '全部笔记'
  const SourceIcon = { manual: NotebookPen, solutions: FileText, information: Radio }
  function browse(nextSource: NoteSource | '', nextTrashed = false) { if (source === nextSource && trashed === nextTrashed) return; filter(() => { setSource(nextSource); setTrashed(nextTrashed) }) }
  const createButton = <button type="button" className="pn-button pn-primary" onClick={() => setEditing(newNote())}><Plus size={16} aria-hidden="true" />新建笔记</button>
  const Content = app ? 'main' : 'div'
  return <section className={`pn-workspace ${app ? 'pn-workspace-app' : 'pn-workspace-embedded'}`} aria-label="我的笔记内容">
    {app && <aside className="pn-sidebar">
      <nav aria-label="笔记分类">
        <p className="pn-nav-label">我的空间</p>
        <button type="button" className="pn-nav" aria-current={!source && !trashed ? 'page' : undefined} onClick={() => browse('')}><FolderOpen size={18} aria-hidden="true" /><span>全部笔记</span></button>
        <p className="pn-nav-label">按来源浏览</p>
        {Object.entries(noteSourceNames).map(([key, label]) => { const Icon = SourceIcon[key as NoteSource]; return <button type="button" key={key} className="pn-nav" aria-current={source === key && !trashed ? 'page' : undefined} onClick={() => browse(key as NoteSource)}><Icon size={18} aria-hidden="true" /><span>{label}</span></button> })}
        <div className="pn-nav-divider" />
        <button type="button" className="pn-nav" aria-current={trashed ? 'page' : undefined} onClick={() => browse('', true)}><Trash2 size={18} aria-hidden="true" /><span>回收站</span></button>
      </nav>
      <div className="pn-sidebar-account"><span className="pn-avatar">{Array.from(userName || '我')[0]}</span><div><strong>{userName || '我的空间'}</strong><span><ShieldCheck size={11} aria-hidden="true" />个人笔记</span></div></div>
    </aside>}
    <Content className="pn-content" id={app ? 'pn-content' : undefined}>
      {app && <div className="pn-page-heading"><div><h2>{heading}<span className="pn-total">{total}</span></h2><p>{trashed ? '暂存移除的笔记，随时可以恢复。' : source ? `整理来自${noteSourceNames[source]}的摘录与思考。` : '把阅读中的收获，沉淀为自己的知识。'}</p></div>{createButton}</div>}
      <div className="pn-tools"><label className="pn-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索我的笔记" placeholder="搜索笔记标题或正文…" maxLength={200} value={search} onChange={event => filter(() => setSearch(event.target.value))} /></label>{!app && <><select aria-label="笔记来源筛选" value={source} onChange={event => filter(() => setSource(event.target.value as NoteSource | ''))}><option value="">全部来源</option>{Object.entries(noteSourceNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className={`pn-button ${trashed ? 'is-active' : ''}`} type="button" onClick={() => filter(() => setTrashed(value => !value))}><Trash2 size={15} aria-hidden="true" />{trashed ? '返回笔记' : '回收站'}</button></>}<button type="button" className="pn-button pn-refresh" aria-label="刷新笔记" title="刷新笔记" onClick={refresh}><RefreshCw size={15} aria-hidden="true" /></button>{!app && createButton}{app && <span className="pn-sort-label">按最近更新排列</span>}</div>
      {notice && <div className="pn-notice" role="status">{notice}{undo && <button type="button" className="pn-button" disabled={busy} onClick={() => void move(undo, true)}>撤销移除</button>}</div>}
      {error && <div role="alert" className="pn-error">{error}<button className="pn-button" type="button" onClick={refresh}>重试读取</button></div>}
      <div className="pn-list-title">{!app && <h2>{trashed ? '回收站' : '全部笔记'} <span>{total}</span></h2>}{loading && <span role="status"><LoaderCircle size={15} className="pn-spin" />读取中…</span>}</div>
      {!items.length && !loading && !error && <div className="pn-empty"><span className="pn-empty-icon">{trashed ? <Trash2 size={27} /> : <NotebookPen size={27} />}</span><h3>{search || source ? '没有匹配的笔记' : trashed ? '回收站为空' : '还没有笔记'}</h3><p>{search || source ? '试试调整关键词和来源筛选。' : trashed ? '移除的笔记会暂存在这里，你可以随时恢复。' : '创建个人记录，或在研究报告、行业信息中选中文字存入笔记。'}</p></div>}
      <div className="pn-grid">{items.map(note => { const Icon = SourceIcon[note.sourceApp]; return <article className="pn-card" key={note.id}>
        <div className="pn-card-meta"><span className="pn-source-badge"><Icon size={13} aria-hidden="true" />{noteSourceNames[note.sourceApp]}</span><time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString('zh-CN')}>{new Date(note.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>
        <button type="button" className="pn-open-note" onClick={() => setEditing(note)} disabled={!!note.deletedAt}><span className="pn-card-title"><h3>{note.title}</h3><ArrowUpRight size={16} aria-hidden="true" /></span><p>{note.content}</p></button>
        {note.sourceTitle && <small className="pn-source-title"><Link2 size={13} aria-hidden="true" /><span>来源：{note.sourceTitle}</span></small>}
        <footer><span className="pn-word-count">{note.content.length.toLocaleString()} 字</span>{note.deletedAt ? <button className="pn-button pn-text-button" type="button" disabled={busy} onClick={() => void move(note, true)}><RotateCcw size={14} aria-hidden="true" />恢复笔记</button> : <><button className="pn-button pn-text-button" type="button" onClick={() => setEditing(note)}><PencilLine size={13} aria-hidden="true" />编辑笔记</button><button className="pn-button pn-text-button pn-trash-action" type="button" disabled={busy} aria-label={`移至回收站：${note.title}`} onClick={() => void move(note, false)}><Trash2 size={13} aria-hidden="true" />移至回收站</button></>}</footer>
      </article> })}</div>
      {items.length < total && <button type="button" className="pn-button pn-load-more" disabled={loading} onClick={() => setOffset(items.length)}>加载更多笔记</button>}
    </Content>
    {editing && <NoteEditor key={editing.id} client={client} draft={editing} existing={'revision' in editing ? editing : undefined} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('笔记已保存。'); refresh() }} />}
  </section>
}
