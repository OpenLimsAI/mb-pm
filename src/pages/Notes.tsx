import ApplicationActions from '../components/application/ApplicationActions'
import { useMemo } from 'react'
import { NotebookPen, ShieldCheck } from 'lucide-react'
import { usePortalContext } from '../components/portal/context'
import NotesWorkspace from '../features/notes/NotesWorkspace'
import { createNotesApi, createPreviewNotesClient, notesApi } from '../features/notes/client'

export default function Notes() {
  const { user, identityNamespace, preview } = usePortalContext()
  const namespace = `${identityNamespace || user.id}:${user.id}`
  const embedded = new URLSearchParams(window.location.search).get('embed') === 'knowledge'
  const identity = embedded ? window.location.hash.slice(1) : ''
  const client = useMemo(() => preview ? createPreviewNotesClient(namespace) : embedded ? createNotesApi(identity || 'invalid') : notesApi, [namespace, preview, embedded, identity])
  return <div className={`pn-app${embedded ? ' pn-app-knowledge-embed' : ''}`}>
    <a className="pn-skip" href="#pn-content">跳至笔记内容</a>
    {!embedded && <header className="pn-app-header">
      <div className="pn-app-brand"><span className="pn-app-mark"><NotebookPen size={21} aria-hidden="true" /></span><h1>我的笔记</h1><span className="pn-app-subtitle">个人知识空间</span>{preview && <span className="pn-preview-badge">演示空间 · 本机保存</span>}</div>
      <ApplicationActions userName={user.displayName || user.username} preview={preview} />
    </header>}
    <NotesWorkspace key={`${namespace}:${preview}`} client={client} mode="app" userName={user.displayName || user.username} acceptParentRefresh={embedded} />
    {!embedded && <footer className="pn-app-footer"><ShieldCheck size={13} aria-hidden="true" /><span>{preview ? '本地预览 · 笔记保存在当前浏览器' : '个人空间 · 笔记默认仅本人可见'}</span><span>迈博药业 · 数字化工作空间</span></footer>}
  </div>
}
