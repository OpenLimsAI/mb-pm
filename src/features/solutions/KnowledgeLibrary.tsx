import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BookOpen, FilePlus2, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { libraryEmbedUrl, readLibraryMessage } from './libraryEmbed'
import './knowledge-library.css'

interface Props {
  preview: boolean
  editable: boolean
  busy: boolean
  canAsk: boolean
  onUse: (path: string, action: 'ask' | 'cite') => void
  onAdd: () => void
  children: ReactNode
  scope: ReactNode
}

export default function KnowledgeLibrary({ preview, editable, busy, canAsk, onUse, onAdd, children, scope }: Props) {
  const [tab, setTab] = useState<'library' | 'report'>('library')
  const [reload, setReload] = useState(0)
  const [ready, setReady] = useState(false)
  const [delayed, setDelayed] = useState(false)
  const [selected, setSelected] = useState<{ path: string; title: string } | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const url = libraryEmbedUrl(preview)
  useEffect(() => {
    if (!url) return
    const origin = new URL(url).origin
    const listen = (event: MessageEvent) => {
      const message = readLibraryMessage(event, frame.current?.contentWindow ?? null, origin)
      if (message?.type === 'ready' && message.preview === preview) setReady(true)
      else if (message?.type === 'selection') setSelected(message.path ? { path: message.path, title: message.title } : null)
    }
    window.addEventListener('message', listen)
    const timer = window.setTimeout(() => setDelayed(true), 8000)
    return () => { window.removeEventListener('message', listen); window.clearTimeout(timer) }
  }, [url, reload, preview])
  function refresh() { setReady(false); setSelected(null); setDelayed(false); setReload(value => value + 1) }
  return <div className="ks-library-workspace">
    <div className="ks-library-toolbar">
      <div role="tablist" aria-label="资料来源">
        <button role="tab" id="ks-library-tab" aria-controls="ks-library-view" aria-selected={tab === 'library'} onClick={() => setTab('library')}><BookOpen size={13} />知识库</button>
        <button role="tab" id="ks-report-sources-tab" aria-controls="ks-report-sources-view" aria-selected={tab === 'report'} onClick={() => setTab('report')}>报告资料</button>
      </div>
      <div className="ks-library-actions">
        {tab === 'library' ? <button className="ks-button" onClick={refresh} aria-label="刷新知识库" title="刷新知识库"><RefreshCw size={14} /></button> : <button className="ks-button" onClick={onAdd}><Plus size={14} />添加资料</button>}
      </div>
    </div>
    <div id="ks-library-view" role="tabpanel" aria-labelledby="ks-library-tab" className="ks-library-view" hidden={tab !== 'library'}>
      <div className="ks-library-frame-wrap">
        {url && <iframe key={reload} ref={frame} src={url} title="原知识库资料" className={ready ? 'is-ready' : ''} referrerPolicy="strict-origin" />}
        {!ready && <div className="ks-library-loading" role="status">
          {url && !delayed ? <><LoaderCircle size={23} className="ks-spin" /><strong>正在打开原知识库…</strong></> : <><BookOpen size={25} /><strong>{url ? '资料视图暂未加载' : '请在本地预览中查看知识库'}</strong></>}
          <p>{preview ? '此处复用原知识库界面，预览使用独立演示资料。' : '使用原知识库的账号权限，继续搜索、整理与阅读资料。'}</p>
          {delayed && <p>{preview ? '请确认本地知识库预览服务已启动，再刷新。' : '请确认知识库服务和登录状态正常，再重新加载。'}</p>}
          {delayed && <button className="ks-button" onClick={refresh}><RefreshCw size={14} />重新加载</button>}
        </div>}
      </div>
      <div className="ks-library-selection">
        <span title={selected?.title}>{selected ? selected.title : '打开一份资料，可用于问答或引用'}</span>
        <div>
          <button className="ks-button" disabled={!ready || !selected || busy || !canAsk} onClick={() => selected && onUse(selected.path, 'ask')}><Plus size={13} />加入问答范围</button>
          <button className="ks-button" disabled={!ready || !selected || busy || !editable} onClick={() => selected && onUse(selected.path, 'cite')}><FilePlus2 size={13} />引用到章节</button>
        </div>
      </div>
    </div>
    <div id="ks-report-sources-view" role="tabpanel" aria-labelledby="ks-report-sources-tab" className="ks-report-sources-view" hidden={tab !== 'report'}>{children}</div>
    {scope}
  </div>
}
