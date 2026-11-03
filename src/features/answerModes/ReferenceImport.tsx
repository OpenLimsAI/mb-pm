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
  const category = origin.originApp === 'solutions' ? '研究报告参考论文' : '个人AI助手参考论文'
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
        <header><div><span>参考论文</span><h2 id={titleId}>导入知识源</h2></div><button type="button" aria-label="关闭论文导入" disabled={busy} onClick={close}><X size={19} /></button></header>
        <div className="qa-reference-body"><h3>{source.title}</h3><a href={href} target="_blank" rel="noopener noreferrer">{href}</a><div className="qa-reference-category"><FolderInput size={17} /><span>分类<strong>{category}</strong></span></div>
          <p id={descriptionId}>先保存论文标题与原始链接，再到知识源下载可公开获取的 PDF 原文。</p>
          {preview && <p className="qa-reference-hint">界面演示：不会保存到服务器或发起下载。</p>}
          {demoImported && <p className="qa-reference-success" role="status"><Check size={16} />演示完成：该论文将归入「{category}」。</p>}
          {result && <div className="qa-reference-success" role="status"><Check size={16} /><span>{result.status === 'queued' ? '下载任务已提交，可在知识源查看进度。' : result.status === 'saved' ? '已保存原文，可在知识源查看。' : result.alreadyImported ? '这篇论文已在知识源中，无需重复导入。' : '论文已导入知识源，尚未下载原文。'}</span></div>}
          {result?.canDownload && result.status === 'imported' && <p className="qa-reference-hint">下载后归入知识库并建立问答索引。</p>}
          {result && !result.canDownload && result.status === 'imported' && <p className="qa-reference-hint">已保留论文信息，可由知识库负责人在知识源中下载。</p>}
          {error && <p className="qa-reference-error" role="alert">{error}</p>}
        </div>
        <footer><button type="button" disabled={busy} onClick={close}>{result || demoImported ? '完成' : '取消'}</button>
          {result ? <>{result.canDownload && result.status === 'imported' && <button type="button" className="is-primary" disabled={busy} onClick={() => void submit(true)}>{busy ? <LoaderCircle className="qa-reference-spin" size={15} /> : <Download size={15} />}下载原文</button>}<a className="qa-reference-link" href={referenceDestination(result)}>查看知识源<ArrowRight size={15} /></a></> : !demoImported && <button type="button" className="is-primary" disabled={busy} onClick={() => void submit(false)}>{busy ? <LoaderCircle className="qa-reference-spin" size={15} /> : <FolderInput size={15} />}{preview ? '演示导入' : busy ? '正在导入…' : '确认导入'}</button>}
        </footer>
      </div>
    </div>, document.body)}
  </div>
}
