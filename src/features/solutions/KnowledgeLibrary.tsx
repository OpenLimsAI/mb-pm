import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BookOpen, FilePlus2, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { libraryEmbedUrl, readLibraryMessage, validLibraryPath } from './libraryEmbed'
import type { LibraryQuote, LibraryNavigation } from './libraryEmbed'
import './knowledge-library.css'

interface Props {
  preview: boolean
  editable: boolean
  busy: boolean
  canAsk: boolean
  onUse: (path: string, action: 'ask' | 'cite', quote?: LibraryQuote) => void
  navigateTo?: LibraryNavigation | null
  scope: ReactNode
}

export default function KnowledgeLibrary({ preview, editable, busy, canAsk, onUse, scope, navigateTo }: Props) {
  const [reload, setReload] = useState(0)
  const [ready, setReady] = useState(false)
  const [delayed, setDelayed] = useState(false)
  const [selected, setSelected] = useState<{ path: string; title: string; quote?: LibraryQuote } | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const url = libraryEmbedUrl(preview)
  useEffect(() => {
    if (!url) return
    const origin = new URL(url).origin
    const listen = (event: MessageEvent) => {
      const message = readLibraryMessage(event, frame.current?.contentWindow ?? null, origin)
      if (message?.type === 'ready' && message.preview === preview) setReady(true)
      else if (message?.type === 'selection') setSelected(message.path ? { path: message.path, title: message.title, quote: message.quote } : null)
    }
    window.addEventListener('message', listen)
    const timer = window.setTimeout(() => setDelayed(true), 8000)
    return () => { window.removeEventListener('message', listen); window.clearTimeout(timer) }
  }, [url, reload, preview])
  useEffect(() => {
    if (!ready || !url || !navigateTo || !validLibraryPath(navigateTo.path)) return
    frame.current?.contentWindow?.postMessage({ type: 'mberp:knowledge-library:navigate', version: 1, path: navigateTo.path, title: navigateTo.title.slice(0, 1000), excerpt: navigateTo.excerpt.slice(0, 4000) }, new URL(url).origin)
  }, [ready, url, navigateTo])
  function refresh() { setReady(false); setSelected(null); setDelayed(false); setReload(value => value + 1) }
  return <div className="ks-library-workspace">
    <div className="ks-library-toolbar">
      <span className="ks-library-label"><BookOpen size={13} />知识库</span>
      <div className="ks-library-actions"><button className="ks-button" onClick={refresh} aria-label="刷新知识库" title="刷新知识库"><RefreshCw size={14} /></button></div>
    </div>
    <div id="ks-library-view" className="ks-library-view">
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
        <span title={selected?.quote?.excerpt || selected?.title}>{selected ? <>{selected.title}{selected.quote && <small> · 已选原文 {selected.quote.excerpt.length} 字</small>}</> : '打开一份资料，可用于问答；选中原文可精确引用'}</span>
        <div>
          <button className="ks-button" disabled={!ready || !selected || busy || !canAsk} onClick={() => selected && onUse(selected.path, 'ask')}><Plus size={13} />加入问答范围</button>
          <button className="ks-button" disabled={!ready || !selected || busy || !editable} onClick={() => { if (selected) { if (selected.quote) onUse(selected.path, 'cite', selected.quote); else onUse(selected.path, 'cite') } }}><FilePlus2 size={13} />{selected?.quote ? '引用选中段落' : '引用到章节'}</button>
        </div>
      </div>
    </div>
    {scope}
  </div>
}
