import { useState } from 'react'
import { ArrowUpRight, BookOpen, FileText, Link2, LoaderCircle, NotebookPen, PencilLine, Plus, Radio, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react'
import type { NotesClient, NoteSource, PersonalNote } from './client'
import { noteSourceNames } from './client'
import type { NoteDraft } from './draft'
import NoteEditor from './NoteEditor'
import NotesAppWorkspace from './NotesAppWorkspace'
import { newNote } from './draft'
import { useNoteCollection } from './useNoteCollection'
import './notes.css'

type Props = { client: NotesClient; mode?: 'app' | 'embedded'; userName?: string; acceptParentRefresh?: boolean }
export default function NotesWorkspace(props: Props) {
  return props.mode === 'app' ? <NotesAppWorkspace {...props} /> : <EmbeddedNotesWorkspace {...props} />
}
function EmbeddedNotesWorkspace({ client, acceptParentRefresh = false }: Props) {
  const { items, total, search, source, trashed, loading, error, notice, undo, busy, refresh, filter, move, share, setNotice, loadMore } = useNoteCollection(client, acceptParentRefresh)
  const [editing, setEditing] = useState<PersonalNote | NoteDraft | null>(null)
  const SourceIcon = { manual: NotebookPen, solutions: FileText, information: Radio, knowledge: BookOpen }
  const createButton = <button type="button" className="pn-button pn-primary" onClick={() => setEditing(newNote())}><Plus size={16} aria-hidden="true" />新建笔记</button>
  return <section className="pn-workspace pn-workspace-embedded" aria-label="我的笔记内容">
    <div className="pn-content">
      <div className="pn-tools"><label className="pn-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索我的笔记" placeholder="搜索笔记标题或正文…" maxLength={200} value={search} onChange={event => filter({ search: event.target.value })} /></label><select aria-label="笔记来源筛选" value={source} onChange={event => filter({ source: event.target.value as NoteSource | '' })}><option value="">全部来源</option>{Object.entries(noteSourceNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className={`pn-button ${trashed ? 'is-active' : ''}`} type="button" onClick={() => filter({ trashed: !trashed })}><Trash2 size={15} aria-hidden="true" />{trashed ? '返回笔记' : '回收站'}</button><button type="button" className="pn-button pn-refresh" aria-label="刷新笔记" title="刷新笔记" onClick={refresh}><RefreshCw size={15} aria-hidden="true" /></button>{createButton}</div>
      {notice && <div className="pn-notice" role="status">{notice}{undo && <button type="button" className="pn-button" disabled={busy} onClick={() => void move(undo, true)}>撤销移除</button>}</div>}
      {error && <div role="alert" className="pn-error">{error}<button className="pn-button" type="button" onClick={refresh}>重试读取</button></div>}
      <div className="pn-list-title"><h2>{trashed ? '回收站' : '全部笔记'} <span>{total}</span></h2>{loading && <span role="status"><LoaderCircle size={15} className="pn-spin" />读取中…</span>}</div>
      {!items.length && !loading && !error && <div className="pn-empty"><span className="pn-empty-icon">{trashed ? <Trash2 size={27} /> : <NotebookPen size={27} />}</span><h3>{search || source ? '没有匹配的笔记' : trashed ? '回收站为空' : '还没有笔记'}</h3><p>{search || source ? '试试调整关键词和来源筛选。' : trashed ? '移除的笔记会暂存在这里，你可以随时恢复。' : '创建个人记录，或在研究报告、行业信息中选中文字存入笔记。'}</p></div>}
      <div className="pn-grid">{items.map(note => { const Icon = SourceIcon[note.sourceApp]; return <article className="pn-card" key={note.id}>
        <div className="pn-card-meta"><span className="pn-source-badge"><Icon size={13} aria-hidden="true" />{noteSourceNames[note.sourceApp]}</span><time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString('zh-CN')}>{new Date(note.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>
        <button type="button" className="pn-open-note" onClick={() => setEditing(note)} disabled={!!note.deletedAt}><span className="pn-card-title"><h3>{note.title}</h3><ArrowUpRight size={16} aria-hidden="true" /></span><p>{note.content}</p></button>
        {note.sourceTitle && <small className="pn-source-title"><Link2 size={13} aria-hidden="true" /><span>来源：{note.sourceTitle}</span></small>}
        {note.wisdom && <small className="pn-sync-status" role="status">{note.wisdom.status === 'synced' ? '已共享到知识库检索' : note.wisdom.status === 'pending' ? '检索副本同步中…' : note.wisdom.status === 'error' ? note.wisdom.error : '仅本人可见'}</small>}
        <footer>{client.share && !note.deletedAt && <button className="pn-button pn-text-button" type="button" disabled={busy} onClick={() => void share(note)}>{note.wisdom?.enabled ? '撤下共享' : '共享到知识库检索'}</button>}<span className="pn-word-count">{note.content.length.toLocaleString()} 字</span>{note.deletedAt ? <button className="pn-button pn-text-button" type="button" disabled={busy} onClick={() => void move(note, true)}><RotateCcw size={14} aria-hidden="true" />恢复笔记</button> : <><button className="pn-button pn-text-button" type="button" onClick={() => setEditing(note)}><PencilLine size={13} aria-hidden="true" />编辑笔记</button><button className="pn-button pn-text-button pn-trash-action" type="button" disabled={busy} aria-label={`移至回收站：${note.title}`} onClick={() => void move(note, false)}><Trash2 size={13} aria-hidden="true" />移至回收站</button></>}</footer>
      </article> })}</div>
      {items.length < total && <button type="button" className="pn-button pn-load-more" disabled={loading} onClick={loadMore}>加载更多笔记</button>}
    </div>
    {editing && <NoteEditor key={editing.id} client={client} draft={editing} existing={'revision' in editing ? editing : undefined} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('笔记已保存。'); refresh() }} />}
  </section>
}
