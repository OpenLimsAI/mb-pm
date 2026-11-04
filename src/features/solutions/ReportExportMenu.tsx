import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Eye, LoaderCircle, X } from 'lucide-react'
import type { Solution } from './types'
import { exportMarkdown, exportPdf, reportPrintMarkup } from './reportDocumentExport'
import { exportPreview } from './export'
import { defaultExportOptions } from './reportExportOptions'
import type { ReportExportOptions } from './reportExportOptions'
import './reportEvidence.css'

export default function ReportExportMenu({ solution, onPrepare, busy = false }: { solution: Solution; onWordExport?: () => Promise<void> | void; onPrepare?: () => Promise<Solution>; busy?: boolean }) {
  const [open, setOpen] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState('')
  const [preview, setPreview] = useState<Solution | null>(null), [options, setOptions] = useState<ReportExportOptions>(defaultExportOptions)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!preview) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
      if (event.key === 'Tab') {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])') || [])], first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [preview])
  async function run(kind: 'word' | 'pdf' | 'markdown' | 'preview') {
    setWorking(true); setError('')
    try {
      const current = onPrepare ? await onPrepare() : solution
      if (kind === 'preview') setPreview(current)
      else if (kind === 'word') exportPreview(current, options)
      else if (kind === 'pdf') await exportPdf(current, options)
      else exportMarkdown(current, options)
      setOpen(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导出失败，请重试。') }
    finally { setWorking(false) }
  }
  return <><div className="ks-export-menu" style={{ position: 'relative' }}><button className="ks-button" type="button" aria-label="导出" aria-expanded={open} disabled={busy || working} onClick={() => setOpen(!open)}>{working ? <LoaderCircle className="ks-spin" size={16} /> : <Download size={16} />}<span className="ks-action-text">{working ? '正在导出…' : '导出'}</span></button>{open && <div role="group" aria-label="导出格式" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 40, minWidth: 220, padding: 10, background: 'white', color: '#24476b', border: '1px solid #c7d8e7', borderRadius: 8, boxShadow: '0 8px 24px #24476b20' }}><button type="button" className="ks-button" onClick={() => void run('preview')}><Eye size={14} />排版设置与导出预览</button>{(['word', 'pdf', 'markdown'] as const).map(kind => <button className="ks-button" style={{ display: 'block', width: '100%', textAlign: 'left' }} type="button" disabled={working} key={kind} onClick={() => void run(kind)}>{kind === 'word' ? 'Word · 可编辑文档' : kind === 'pdf' ? 'PDF · 排版文档' : 'Markdown · 原始正文'}</button>)}<button className="ks-button" type="button" onClick={() => setOpen(false)}>关闭</button>{error && <p role="alert" style={{ color: '#a83838', fontSize: 12 }}>{error}</p>}</div>}</div>
  {preview && preview.id === solution.id && createPortal(<div className="ks-overlay" onMouseDown={event => { if (event.currentTarget === event.target) setPreview(null) }}><div ref={dialog} tabIndex={-1} className="ks-modal ks-modal-wide" role="dialog" aria-modal="true" aria-label="报告导出预览"><header><h2>报告导出预览</h2><button type="button" className="ks-button" aria-label="关闭导出预览" onClick={() => setPreview(null)}><X size={17} /></button></header><div className="ks-export-options"><label>排版模板<select aria-label="导出排版模板" value={options.template} onChange={event => setOptions({ ...options, template: event.target.value as ReportExportOptions['template'] })}><option value="standard">标准研究报告</option><option value="compact">紧凑阅读</option></select></label><label>机构名称<input type="text" aria-label="导出机构名称" maxLength={120} value={options.organization} placeholder="填写企业或研究机构" onChange={event => setOptions({ ...options, organization: event.target.value })} /></label><label><input type="checkbox" checked={options.cover} onChange={event => setOptions({ ...options, cover: event.target.checked })} />封面信息</label><label><input type="checkbox" checked={options.figureIndex} onChange={event => setOptions({ ...options, figureIndex: event.target.checked })} />图表目录</label><label>文献格式<select aria-label="参考文献格式" value={options.bibliography} onChange={event => setOptions({ ...options, bibliography: event.target.value as ReportExportOptions['bibliography'] })}><option value="detailed">编号 · 标题、版本与定位</option><option value="titles">编号 · 简洁标题</option></select></label></div><p className="ks-muted">预览显示已保存正文及文献顺序；PDF 按 A4 分页并生成页码，Word 的目录可在打开后更新域。</p><div className="ks-export-preview" dangerouslySetInnerHTML={{ __html: reportPrintMarkup(preview, options) }} /><footer><button type="button" className="ks-button" disabled={working} onClick={() => void run('word')}>导出 Word</button><button type="button" className="ks-button ks-primary" disabled={working} onClick={() => void run('pdf')}>{working ? '正在生成…' : '导出 PDF'}</button></footer>{error && <p role="alert">{error}</p>}</div></div>, document.querySelector('.ks-app') || document.body)}
  </>
}
