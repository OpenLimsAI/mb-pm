import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, ExternalLink, FileText, FolderOpen, Link2, LoaderCircle, NotebookPen, PencilLine, Plus, Radio, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { noteSourceNames, noteSourceUrl } from './client'
import type { NotesClient, NoteSource, PersonalNote } from './client'
import { newNote } from './draft'
import type { NoteDraft } from './draft'
import NoteEditor from './NoteEditor'
import { useNoteCollection } from './useNoteCollection'
import './notes.css'
import './notes-workspace.css'

const sourceIcons = { manual: NotebookPen, solutions: FileText, information: Radio, knowledge: BookOpen }
const updatedAt = (note: PersonalNote) => new Date(note.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const excerpt = (content: string) => content.replace(/^#{1,6}\s+/gm, '').replace(/^[>*-]\s+/gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim()

export default function NotesAppWorkspace({ client, userName, acceptParentRefresh = false }: { client: NotesClient; userName?: string; acceptParentRefresh?: boolean }) {
  const collection = useNoteCollection(client, acceptParentRefresh)
  const { items, total, search, source, trashed, loading, error, notice, undo, busy, refresh, filter, move, share } = collection
  const [selection, setSelection] = useState<{ client: NotesClient; id: string; linked?: PersonalNote; referenced?: boolean } | null>(null)
  const [editing, setEditing] = useState<PersonalNote | NoteDraft | null>(null)
  const [detailOpen, setDetailOpen] = useState(false), [linkedError, setLinkedError] = useState('')
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const reader = useRef<HTMLElement>(null)
  const editorState = useRef({ dirty: false, busy: false })
  const reportEditorState = useCallback((state: typeof editorState.current) => { editorState.current = state }, [])
  const [linkedId] = useState(() => new URLSearchParams(window.location.search).get('note')?.slice(0, 128) || '')
  useEffect(() => {
    let active = true
    if (!linkedId || !client.get) return
    client.get(linkedId).then(note => {
      if (active) { setSelection({ client, id: note.id, linked: note, referenced: true }); setDetailOpen(true); setLinkedError('') }
    }).catch(() => { if (active) setLinkedError('无法打开引用的笔记：笔记可能已删除，或不属于当前登录账号。') })
    return () => { active = false }
  }, [client, linkedId])
  const ownedSelection = selection?.client === client ? selection : null
  const selected = collection.accessLost ? null : items.find(note => note.id === ownedSelection?.id) || ownedSelection?.linked || items[0] || null
  useEffect(() => { if (reader.current) reader.current.scrollTop = 0 }, [selected?.id])
  const heading = trashed ? '回收站' : source ? noteSourceNames[source] : '全部笔记'
  function transition(action: () => void) {
    if (editing && editorState.current.busy) { collection.setNotice('笔记正在保存，请稍候。'); return }
    if (editing && editorState.current.dirty) { setPendingAction(() => action); return }
    setEditing(null); editorState.current = { dirty: false, busy: false }; setPendingAction(null); action()
  }
  function browse(nextSource: NoteSource | '', nextTrashed = false) {
    if (source === nextSource && trashed === nextTrashed) return
    transition(() => { filter({ source: nextSource, trashed: nextTrashed }); setSelection(null); setDetailOpen(false); setLinkedError('') })
  }
  function open(note: PersonalNote) {
    if (editing?.id === note.id) { setDetailOpen(true); return }
    transition(() => { setSelection({ client, id: note.id }); setDetailOpen(true); setLinkedError('') })
  }
  function create() {
    transition(() => { filter({ source: '', trashed: false, search: '' }); setEditing(newNote()); setDetailOpen(true); setLinkedError('') })
  }
  function saved(note: PersonalNote) {
    const next = pendingAction
    setEditing(null); setPendingAction(null); editorState.current = { dirty: false, busy: false }
    setSelection({ client, id: note.id, linked: note }); collection.setNotice('笔记已保存。'); refresh(); next?.()
  }
  const SelectedIcon = selected ? sourceIcons[selected.sourceApp] : NotebookPen
  const originUrl = selected && noteSourceUrl(selected.sourceUrl)
  return <section className={`pn-workspace pn-three-pane${detailOpen ? ' pn-detail-open' : ''}`} aria-label="我的笔记内容">
    <aside className="pn-sidebar">
      <nav aria-label="笔记分类">
        <p className="pn-nav-label">我的空间</p>
        <button type="button" className="pn-nav" aria-current={!source && !trashed ? 'page' : undefined} onClick={() => browse('')}><FolderOpen size={18} aria-hidden="true" /><span>全部笔记</span></button>
        <p className="pn-nav-label">按来源浏览</p>
        {Object.entries(noteSourceNames).map(([key, label]) => { const Icon = sourceIcons[key as NoteSource]; return <button type="button" key={key} className="pn-nav" aria-current={source === key && !trashed ? 'page' : undefined} onClick={() => browse(key as NoteSource)}><Icon size={18} aria-hidden="true" /><span>{label}</span></button> })}
        <div className="pn-nav-divider" />
        <button type="button" className="pn-nav" aria-current={trashed ? 'page' : undefined} onClick={() => browse('', true)}><Trash2 size={18} aria-hidden="true" /><span>回收站</span></button>
      </nav>
      <div className="pn-sidebar-account"><span className="pn-avatar">{Array.from(userName || '我')[0]}</span><div><strong title={userName || '我的空间'}>{userName || '我的空间'}</strong><span><ShieldCheck size={11} aria-hidden="true" />个人笔记</span></div></div>
    </aside>
    <section className="pn-note-list" aria-label="笔记列表">
      <header className="pn-list-header">
        <div className="pn-list-heading"><h2>{heading}<span className="pn-total">{total}</span></h2><button type="button" className="pn-button pn-add-note" onClick={create}><Plus size={15} aria-hidden="true" />新建笔记</button></div>
        <div className="pn-list-search"><label className="pn-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索我的笔记" placeholder="搜索笔记标题或正文…" maxLength={200} value={search} onChange={event => { const value = event.target.value; transition(() => { filter({ search: value }); setSelection(null) }) }} /></label><button type="button" className="pn-button pn-refresh" aria-label="刷新笔记" title="刷新笔记" onClick={refresh}><RefreshCw size={15} aria-hidden="true" /></button></div>
        <div className="pn-list-caption"><span>按最近更新排列</span>{loading && <span role="status"><LoaderCircle size={12} className="pn-spin" aria-hidden="true" />读取中…</span>}</div>
      </header>
      <div className="pn-note-list-scroll">
        {notice && <div className="pn-notice" role="status">{notice}{undo && <button type="button" className="pn-button" disabled={busy} onClick={() => transition(() => { void move(undo, true) })}>撤销移除</button>}</div>}
        {error && <div className="pn-error" role="alert">{error}<button type="button" className="pn-button" onClick={refresh}>重试读取</button></div>}
        {linkedError && <p className="pn-error" role="alert">{linkedError}</p>}
        {!items.length && !loading && !error && <div className="pn-list-empty"><NotebookPen size={26} aria-hidden="true" /><h3>{search || source ? '没有匹配的笔记' : trashed ? '回收站为空' : '还没有笔记'}</h3><p>{search || source ? '试试调整关键词和来源筛选。' : trashed ? '移除的笔记会暂存在这里。' : '新建个人记录，或从阅读内容中保存摘录。'}</p></div>}
        <ul className="pn-note-rows">{items.map(note => { const Icon = sourceIcons[note.sourceApp]; return <li key={note.id}><button type="button" className="pn-note-row" aria-label={`查看笔记：${note.title}`} aria-current={selected?.id === note.id && !editing ? 'true' : undefined} onClick={() => open(note)}>
          <span className="pn-row-icon"><Icon size={19} aria-hidden="true" /></span><span className="pn-row-copy"><span className="pn-row-title">{note.title}</span><span className="pn-row-excerpt">{excerpt(note.content)}</span><span className="pn-row-meta"><span className="pn-source-badge">{noteSourceNames[note.sourceApp]}</span><time dateTime={note.updatedAt}>{updatedAt(note)}</time></span></span>
        </button></li> })}</ul>
        {items.length < total && <button type="button" className="pn-button pn-load-more" disabled={loading} onClick={collection.loadMore}>加载更多笔记</button>}
      </div>
    </section>
    <main className="pn-note-detail" id="pn-content" aria-label="笔记内容">
      <button type="button" className="pn-button pn-back-to-list" onClick={() => transition(() => setDetailOpen(false))}><ArrowLeft size={15} aria-hidden="true" />返回笔记列表</button>
      {pendingAction && <div className="pn-unsaved-banner" role="alert"><span>当前笔记有未保存的内容，请先保存或选择放弃更改。</span><div><button type="button" className="pn-button" onClick={() => setPendingAction(null)}>继续编辑</button><button type="button" className="pn-button" onClick={() => { const next = pendingAction; setPendingAction(null); setEditing(null); editorState.current = { dirty: false, busy: false }; next() }}>放弃更改并继续</button></div></div>}
      {editing ? <NoteEditor inline key={editing.id} client={client} draft={editing} existing={'revision' in editing ? editing : undefined} onStateChange={reportEditorState} onClose={() => transition(() => {})} onSaved={saved} /> : selected ? <>
        <header className="pn-reader-toolbar"><span className="pn-reader-label"><SelectedIcon size={16} aria-hidden="true" />{noteSourceNames[selected.sourceApp]}</span><div className="pn-reader-actions">{selected.deletedAt ? <button type="button" className="pn-button" disabled={busy} onClick={() => { void move(selected, true).then(note => { if (note) setSelection(null) }) }}><RotateCcw size={15} aria-hidden="true" />恢复笔记</button> : <><button type="button" className="pn-button" onClick={() => setEditing(selected)}><PencilLine size={15} aria-hidden="true" />编辑笔记</button><button type="button" className="pn-button pn-reader-trash" disabled={busy} aria-label={`移至回收站：${selected.title}`} onClick={() => { void move(selected, false).then(note => { if (note) setSelection(null) }) }}><Trash2 size={15} aria-hidden="true" /></button></>}</div></header>
        <article ref={reader} className="pn-reader-scroll" aria-label={ownedSelection?.referenced ? '引用的笔记' : '笔记全文'}>
          <div className="pn-reader-paper"><h2>{selected.title}</h2><div className="pn-reader-meta"><time dateTime={selected.updatedAt}>更新于 {new Date(selected.updatedAt).toLocaleString('zh-CN')}</time><span>{selected.content.length.toLocaleString()} 字</span></div>
            {selected.deletedAt && <p className="pn-notice">这条笔记已移至回收站，恢复后可继续编辑。</p>}
            {(selected.sourceTitle || originUrl) && <div className="pn-reader-origin"><Link2 size={14} aria-hidden="true" /><span>{selected.sourceTitle || '原文来源'}</span>{originUrl && <a href={originUrl} target="_blank" rel="noreferrer">查看来源<ExternalLink size={12} aria-hidden="true" /></a>}</div>}
            <div className="pn-reading-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, title, children }) => <a href={href} title={title} target="_blank" rel="noreferrer">{children}</a> }}>{selected.content}</ReactMarkdown></div>
          </div>
        </article>
        <footer className="pn-reader-footer"><span><ShieldCheck size={13} aria-hidden="true" />{selected.wisdom?.status === 'synced' ? '已共享到知识库检索' : selected.wisdom?.status === 'pending' ? '检索副本同步中…' : selected.wisdom?.status === 'error' ? selected.wisdom.error : '仅本人可见'}</span>{client.share && !selected.deletedAt && <button type="button" className="pn-button pn-text-button" disabled={busy} onClick={() => { void share(selected) }}>{selected.wisdom?.enabled ? '撤下共享' : '共享到知识库检索'}</button>}</footer>
      </> : <div className="pn-reader-placeholder"><BookOpen size={38} aria-hidden="true" /><h2>让每一条思考都有自己的位置</h2><p>从左侧列表选择笔记，在这里阅读全文。</p><button type="button" className="pn-button pn-primary" onClick={create}><Plus size={15} aria-hidden="true" />写下第一条笔记</button></div>}
    </main>
  </section>
}
