import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, FileText, Maximize2, Minimize2, Star, X } from 'lucide-react'
import { sourceError, type KnowledgeSourceSnapshot } from './api'
import { knowledgeV3Post, type LibraryPaper, type PaperDetail } from './v3-api'
import PaperActions from './PaperActions'
import PaperMetadataEditor from './PaperMetadataEditor'
import SharedPaperTags from './SharedPaperTags'
import { PaperVersions } from './SourceInsights'
import { VersionChangePanel } from './SourceWatchPanel'
import ManualIndexPanel from './ManualIndexPanel'
const PdfReader=lazy(()=>import('./PdfReader'))

function safeUrl(value?: string) { try { const u = new URL(value || '', window.location.origin); return value && ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined } catch { return undefined } }
function readingLink(value: string | undefined, returnTo: string, bilingual = false) {
  const safe = safeUrl(value)
  if (!safe) return undefined
  const url = new URL(safe)
  url.searchParams.set('returnTo', returnTo); url.searchParams.set('returnLabel', '返回知识源')
  if (bilingual) url.searchParams.set('bilingual', '1')
  return url.href
}
export default function PaperReaderPanel({ paper, data, query, initialOffset, onClose, onNext, onPrevious, canNext, canPrevious, onChanged, onPosition, onPdfPosition,onStar,onRetry,busy=false }: {
  paper: LibraryPaper; query: string; onClose: () => void; onNext: () => void; onPrevious: () => void
  data: KnowledgeSourceSnapshot; initialOffset?: number
  canNext: boolean; canPrevious: boolean; onChanged: () => void; onPosition?: (offset: number) => void
  onPdfPosition?: (page:number)=>void
  onStar?: (paperId:string,enabled:boolean)=>Promise<boolean>;busy?:boolean
  onRetry?: (documentId:string)=>Promise<boolean>
}) {
  const [detail, setDetail] = useState<PaperDetail | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [offset, setOffset] = useState(initialOffset ?? paper.reading?.position?.offset ?? 0)
  const [mode, setMode] = useState<'text' | 'pdf'>(paper.reading?.position?.section==='pdf'||(paper.reading?.position?.page&&!paper.reading.position.section)?'pdf':'text'), [expanded, setExpanded] = useState(false), [quote, setQuote] = useState(''), [refresh, setRefresh] = useState(0)
  const [quoteOffset, setQuoteOffset] = useState<number | undefined>(undefined)
  const [confirmIndex,setConfirmIndex]=useState(false)
  const documentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const abort = new AbortController()
    void knowledgeV3Post<PaperDetail>('/library/detail', { paperId: paper.id, query, offset, limit: 48000 }, abort.signal).then(result => { setDetail(result); setError(''); setQuote('') }).catch(e => { if (!abort.signal.aborted) setError(sourceError(e)) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [paper.id, query, offset, refresh])
  const original = safeUrl(detail?.originalUrl || paper.originalUrl)
  const returnUrl = new URL(window.location.href); returnUrl.searchParams.set('paper', paper.id)
  const kbLink = readingLink(detail?.kbUrl || paper.kbUrl, returnUrl.href)
  const starred=data.starred.includes(paper.id)||!!paper.versionId&&data.starred.includes('archive:'+paper.versionId)
  const translationLink = readingLink(detail?.kbUrl || paper.kbUrl, returnUrl.href, true)
  const current = detail?.textOffset ?? offset, total = detail?.totalCharacters ?? detail?.text?.length ?? 0
  function prefixOffset(node: Node, offset: number) {
    const element = documentRef.current
    if (!element || !element.contains(node)) return undefined
    const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, offset)
    const prefix = range.toString()
    return current + (detail?.positionUnit === 'codepoint' ? [...prefix].length : prefix.length)
  }
  function selectText() {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode || !documentRef.current?.contains(selection.anchorNode) || !documentRef.current.contains(selection.focusNode)) return
    const range = selection.getRangeAt(0)
    setQuote([...selection.toString()].slice(0,10000).join('')); setQuoteOffset(prefixOffset(range.startContainer, range.startOffset))
  }
  function recordPosition() {
    const element = documentRef.current
    if (!element) return
    const box = element.getBoundingClientRect()
    const documentWithCaret = document as Document & { caretRangeFromPoint?: (x:number,y:number)=>Range|null }
    const caret = documentWithCaret.caretRangeFromPoint?.(box.left + 28, box.top + 8)
    onPosition?.(caret ? prefixOffset(caret.startContainer,caret.startOffset) ?? current : current)
  }
  function changeOffset(value: number) { setLoading(true); setOffset(value); onPosition?.(value) }
  return <aside className={`ksv-reader${expanded ? ' is-expanded' : ''}`} aria-label="页内论文阅读器">
    <header className="ksv-reader-header"><div className="kso-actions"><button type="button" className="kso-icon-btn" aria-label="上一篇论文" disabled={!canPrevious} onClick={onPrevious}><ChevronLeft /></button><button type="button" className="kso-icon-btn" aria-label="下一篇论文" disabled={!canNext} onClick={onNext}><ChevronRight /></button><span className="kso-small">页内阅读</span></div><div className="kso-actions"><button type="button" className="kso-icon-btn" aria-label={expanded ? '退出放大阅读' : '放大阅读'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 /> : <Maximize2 />}</button><button type="button" className="kso-icon-btn" aria-label="关闭阅读器" onClick={onClose}><X /></button></div></header>
    <div className="ksv-reader-title"><h2>{detail?.paper.title || paper.title}</h2><div className="kso-actions"><button type="button" className={`kso-btn${mode === 'text' ? ' primary' : ''}`} onClick={() => setMode('text')}><FileText />正文</button>{original && <button type="button" className={`kso-btn${mode === 'pdf' ? ' primary' : ''}`} onClick={() => setMode('pdf')}>PDF 原件</button>}{onStar&&<button className="kso-btn" disabled={busy} onClick={()=>void onStar(paper.id,!starred)} aria-label={starred?'取消收藏论文':'收藏论文'}><Star fill={starred?'currentColor':'none'}/>{starred?'已收藏':'收藏'}</button>}{kbLink && <a className="kso-btn" href={kbLink}>在知识库阅读<ArrowUpRight /></a>}{translationLink && <a className="kso-btn" href={translationLink}>中英对照阅读</a>}</div></div>
    {loading && <p role="status" className="ksv-reader-message">正在读取资料…</p>}{error && <p role="alert" className="kso-error ksv-reader-message">{error}<button className="kso-btn" onClick={() => setRefresh(n => n + 1)}>重试读取</button></p>}
    <div className="ksv-reader-message"><span className="kso-chip">{paper.saved?'原件已保存':'知识库资料'}</span> <span className={`kso-chip ${paper.indexStatus==='ready'?'green':paper.indexStatus==='failed'||paper.parseStatus==='failed'?'warn':''}`}>{paper.parseStatus==='failed'?'正文解析待重试':({ready:'可问答',pending:'正在建立索引',failed:'问答索引待重试',not_requested:'尚未建立问答索引'}[paper.indexStatus] || '索引状态待确认')}</span>{paper.type==='手动上传'?<ManualIndexPanel paperId={paper.id} canManage={data.canOrganize} indexStatus={paper.indexStatus} onChanged={onChanged}/>:paper.documentId&&data.canManage&&onRetry&&paper.indexStatus!=='ready'&&<div><button className="kso-btn" disabled={busy||paper.indexStatus==='pending'} onClick={()=>setConfirmIndex(!confirmIndex)}>{paper.parseStatus==='failed'?'重试解析和索引':'建立或重试问答索引'}</button>{confirmIndex&&<div className="kso-note">将处理知识库中待索引资料，原件继续保留。<button className="kso-btn primary" disabled={busy} onClick={()=>{void onRetry(paper.documentId!).then(ok=>{if(ok)setConfirmIndex(false)})}}>确认建立索引</button><button className="kso-btn quiet" onClick={()=>setConfirmIndex(false)}>取消</button></div>}</div>}</div>
    {mode === 'pdf' && original ? <Suspense fallback={<p className="ksv-reader-message">正在加载PDF阅读器…</p>}><PdfReader url={original} title={paper.title} initialPage={paper.reading?.position?.page || 1} onPosition={onPdfPosition}/></Suspense> : detail && !error && <>
      {total > 48000 && <div className="ksv-reader-paging"><button className="kso-btn" disabled={current === 0 || loading} onClick={() => changeOffset(Math.max(0, current - 48000))}>上一段</button><span>正文字符 {current + 1}—{current + (detail.text?.length || 0)} / {total}</span><button className="kso-btn" disabled={current + (detail.text?.length || 0) >= total || loading} onClick={() => changeOffset(current + 48000)}>下一段</button></div>}
      {detail.text ? <div ref={documentRef} className="ksv-document" tabIndex={0} onMouseUp={selectText} onKeyUp={selectText} onScroll={recordPosition}>{query ? detail.text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig')).map((part, i) => part.toLocaleLowerCase() === query.toLocaleLowerCase() ? <mark key={i}>{part}</mark> : part) : detail.text}</div> : <p className="ksv-reader-message">尚无可提取正文。{original ? '可以切换到 PDF 原件阅读，或在知识库完成解析。' : '可从知识库查看已有资料或补充原件。'}</p>}
    </>}
    {detail && <div className="ksv-reader-info"><PaperMetadataEditor key={`${paper.id}:${detail.metadataRevision || 0}`} detail={detail} onSaved={() => { setRefresh(n => n + 1); onChanged() }} /><SharedPaperTags key={`tags:${paper.id}:${detail.insightRevision || 0}`} detail={detail} onSaved={()=>{setRefresh(n=>n+1);onChanged()}}/><PaperVersions paper={{...paper,...detail.paper}} data={data}/>{paper.documentId&&<VersionChangePanel documentId={paper.documentId} versions={data.documents.find(d=>d.id===paper.documentId)?.versions || []}/>}<PaperActions paper={{ ...paper, ...detail.paper }} quote={quote} quoteOffset={quoteOffset} /></div>}
  </aside>
}
