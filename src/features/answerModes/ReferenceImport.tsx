import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, Download, FolderInput, LoaderCircle, X } from 'lucide-react'
import { importKnowledgeReference, sourceError, type ImportedReference, type ReferenceOrigin } from '../knowledge-sources/api'
import type { WebReference } from './types'
import { safeWebSourceUrl } from './sourceUrl'
import './referenceImport.css'

export type { ReferenceOrigin } from '../knowledge-sources/api'
function referenceDestination(value: ImportedReference): string {
  const query = new URLSearchParams({ source: value.sourceId, document: value.documentId })
  if (value.jobId) query.set('job', value.jobId)
  return `/knowledge-sources?${query}`
}

export default function ReferenceImport({ source, origin, preview = false }: { source: WebReference; origin: ReferenceOrigin; preview?: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState<ImportedReference | null>(null), [demoImported, setDemoImported] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null), lock = useRef(false), alive = useRef(true)
  const titleId = useId(), descriptionId = useId()
  const category = result?.category || (origin.originApp === 'solutions' ? '研究报告参考资料' : '个人AI助手参考资料')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!open) return
    const previous = trigger.current
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { previous?.focus() }
  }, [open])
  const href = safeWebSourceUrl(source.url)
  if (!href) return null
  function close() { if (!lock.current) setOpen(false) }
  async function submit(download: boolean) {
    if (lock.current) return
    if (preview) { setDemoImported(true); return }
    lock.current = true; setBusy(true); setError('')
    try {
      const imported = await importKnowledgeReference({ ...origin, referenceId: source.id, download })
      if (alive.current) setResult(imported)
    } catch (reason) { if (alive.current) setError(sourceError(reason)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="qa-reference-import">
    <button type="button" ref={trigger} onClick={() => { setOpen(true); setError('') }}><FolderInput size={13} />{result ? '已导入 · 查看' : '导入知识源'}</button>
    {open && createPortal(<div className="qa-reference-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div ref={dialog} className="qa-reference-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); close() }
        if (event.key === 'Tab') {
          event.stopPropagation()
          const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button,a[href]') || []).filter(element => !element.hasAttribute('disabled'))
          const first = elements[0], last = elements.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
        <header><div><span>参考资料</span><h2 id={titleId}>导入知识源</h2></div><button type="button" aria-label="关闭资料导入" disabled={busy} onClick={close}><X size={19} /></button></header>
        <div className="qa-reference-body"><h3>{source.title}</h3><a href={href} target="_blank" rel="noopener noreferrer">{href}</a><div className="qa-reference-category"><FolderInput size={17} /><span>分类<strong>{category}</strong></span></div>
          <p id={descriptionId}>导入仅保存标题与来源链接，不代表已下载 PDF 或可用于知识库问答。下载时查找公开 PDF，找不到会提示“无法下载”并保留来源链接。</p>
          {preview && <p className="qa-reference-hint">界面演示：不会保存到服务器或发起下载。</p>}
          {demoImported && <p className="qa-reference-success" role="status"><Check size={16} />演示完成：该资料链接将归入「{category}」。</p>}
          {result && <div className="qa-reference-success" role="status"><Check size={16} /><span>{result.status === 'queued' ? '下载任务已提交，可在知识源查看进度。' : result.status === 'saved' ? 'PDF 原件已保存，可在知识源查看解析与索引状态。' : result.alreadyImported ? '此来源链接已在知识源中，尚未保存 PDF。' : '来源链接已保存，尚未下载 PDF。'}</span></div>}
          {result?.canDownload && result.status === 'imported' && <p className="qa-reference-hint">找到公开 PDF 后下载并建立问答索引；无法下载的链接不会加入问答索引。</p>}
          {result && !result.canDownload && result.status === 'imported' && <p className="qa-reference-hint">已保留来源链接，可由知识库负责人在知识源中尝试下载 PDF。</p>}
          {error && <p className="qa-reference-error" role="alert">{error}</p>}
        </div>
        <footer><button type="button" disabled={busy} onClick={close}>{result || demoImported ? '完成' : '取消'}</button>
          {result ? <>{result.canDownload && result.status === 'imported' && <button type="button" className="is-primary" disabled={busy} onClick={() => void submit(true)}>{busy ? <LoaderCircle className="qa-reference-spin" size={15} /> : <Download size={15} />}查找并下载 PDF</button>}<a className="qa-reference-link" href={referenceDestination(result)}>查看知识源<ArrowRight size={15} /></a></> : !demoImported && <button type="button" className="is-primary" disabled={busy} onClick={() => void submit(false)}>{busy ? <LoaderCircle className="qa-reference-spin" size={15} /> : <FolderInput size={15} />}{preview ? '演示导入' : busy ? '正在导入…' : '确认导入'}</button>}
        </footer>
      </div>
    </div>, document.body)}
  </div>
}
