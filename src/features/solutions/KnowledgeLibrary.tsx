import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BookOpen, FilePlus2, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { isLibraryLoginComplete, libraryEmbedUrl, libraryLoginUrl, readLibraryMessage, validLibraryPath } from './libraryEmbed'
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'delayed' | 'auth-required' | 'unavailable' | 'forbidden'>('loading')
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [selected, setSelected] = useState<{ path: string; title: string; quote?: LibraryQuote } | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const loginWindow = useRef<Window | null>(null)
  const recovering = useRef(false)
  const lastFocusRetry = useRef(0)
  const url = libraryEmbedUrl(preview)
  const ready = status === 'ready'
  const refresh = useCallback(() => { setStatus('loading'); setSelected(null); setPopupBlocked(false); setReload(value => value + 1) }, [])
  useEffect(() => {
    if (!url) return
    const origin = new URL(url).origin
    let frameReady = false
    const timer = window.setTimeout(() => setStatus('delayed'), 8000)
    const listen = (event: MessageEvent) => {
      if (recovering.current && isLibraryLoginComplete(event, loginWindow.current, origin)) {
        recovering.current = false
        loginWindow.current = null
        refresh()
        return
      }
      const message = readLibraryMessage(event, frame.current?.contentWindow ?? null, origin)
      if (message?.type === 'ready' && message.preview === preview) {
        window.clearTimeout(timer)
        frameReady = true
        recovering.current = false
        setStatus('ready')
      } else if (message?.type === 'auth-required' || message?.type === 'error') {
        window.clearTimeout(timer)
        frameReady = false
        setSelected(null)
        setStatus(message.type === 'auth-required' ? 'auth-required' : message.reason)
        if (message.type === 'error' && message.reason === 'forbidden') recovering.current = false
      } else if (frameReady && message?.type === 'selection') setSelected(message.path ? { path: message.path, title: message.title, quote: message.quote } : null)
    }
    window.addEventListener('message', listen)
    return () => { window.removeEventListener('message', listen); window.clearTimeout(timer) }
  }, [url, reload, preview, refresh])
  useEffect(() => {
    // COOP or a browser policy can sever opener. A user returning from the
    // explicitly opened login window can still recover without losing a draft.
    const resume = () => {
      if (!recovering.current || document.visibilityState === 'hidden' || Date.now() - lastFocusRetry.current < 1000) return
      lastFocusRetry.current = Date.now()
      refresh()
    }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => { window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume) }
  }, [refresh])
  useEffect(() => {
    if (!ready || !url || !navigateTo || !validLibraryPath(navigateTo.path)) return
    frame.current?.contentWindow?.postMessage({ type: 'mberp:knowledge-library:navigate', version: 1, path: navigateTo.path, title: navigateTo.title.slice(0, 1000), excerpt: navigateTo.excerpt.slice(0, 4000) }, new URL(url).origin)
  }, [ready, url, navigateTo])
  function recoverLogin() {
    if (preview) return
    try {
      if (loginWindow.current && !loginWindow.current.closed) {
        loginWindow.current.focus()
      } else {
        loginWindow.current = window.open(libraryLoginUrl(), '_blank', 'popup,width=600,height=760')
      }
      recovering.current = true
      setPopupBlocked(!loginWindow.current)
    } catch {
      setPopupBlocked(true)
    }
  }
  const waiting = url && status === 'loading'
  const title = !url ? '请在本地预览中查看知识库' : status === 'auth-required' ? '知识库登录状态需要恢复'
    : status === 'unavailable' ? '暂时无法连接知识库' : status === 'forbidden' ? '当前账号没有知识库访问权限' : '资料视图暂未加载'
  return <div className="ks-library-workspace">
    <div className="ks-library-toolbar">
      <span className="ks-library-label"><BookOpen size={13} />知识库</span>
      <div className="ks-library-actions"><button className="ks-button" onClick={refresh} aria-label="刷新知识库" title="刷新知识库"><RefreshCw size={14} /></button></div>
    </div>
    <div id="ks-library-view" className="ks-library-view">
      <div className="ks-library-frame-wrap">
        {url && <iframe key={reload} ref={frame} src={url} title="原知识库资料" className={ready ? 'is-ready' : ''} referrerPolicy="strict-origin" />}
        {!ready && <div className="ks-library-loading" role="status">
          {waiting ? <><LoaderCircle size={23} className="ks-spin" /><strong>正在打开原知识库…</strong></> : <><BookOpen size={25} /><strong>{title}</strong></>}
          <p>{preview ? '此处复用原知识库界面，预览使用独立演示资料。' : status === 'auth-required' ? '在新窗口继续统一身份验证，完成后自动重新加载资料。当前报告保持打开。' : status === 'forbidden' ? '请联系管理员确认当前账号的知识库权限。' : status === 'unavailable' ? '知识库或统一身份服务暂时不可用，请稍后重新加载。' : '使用原知识库的账号权限，继续搜索、整理与阅读资料。'}</p>
          {status === 'delayed' && <p>{preview ? '请确认本地知识库预览服务已启动，再刷新。' : '资料加载较慢，可以重新加载，或在新窗口恢复统一登录。'}</p>}
          {!preview && (status === 'auth-required' || status === 'delayed' || status === 'unavailable') && <button className="ks-button" onClick={recoverLogin}>恢复知识库登录</button>}
          {popupBlocked && <p role="alert">登录窗口未能打开。请允许此站点弹出新窗口，再点击恢复知识库登录；完成验证后可重新加载资料。</p>}
          {url && status !== 'loading' && <button className="ks-button" onClick={refresh}><RefreshCw size={14} />重新加载</button>}
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
