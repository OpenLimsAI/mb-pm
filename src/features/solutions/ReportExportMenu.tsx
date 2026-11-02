import { useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import type { Solution } from './types'
import { exportMarkdown, exportPdf } from './reportDocumentExport'

export default function ReportExportMenu({ solution, onWordExport, onPrepare, busy = false }: { solution: Solution; onWordExport: () => Promise<void> | void; onPrepare?: () => Promise<Solution>; busy?: boolean }) {
  const [open, setOpen] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState('')
  async function run(kind: 'word' | 'pdf' | 'markdown') {
    setWorking(true); setError('')
    try { const current = onPrepare ? await onPrepare() : solution; if (kind === 'word') await onWordExport(); else if (kind === 'pdf') await exportPdf(current); else exportMarkdown(current); setOpen(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '导出失败，请重试。') }
    finally { setWorking(false) }
  }
  return <div className="ks-export-menu" style={{ position: 'relative' }}><button className="ks-button" type="button" aria-label="导出" aria-expanded={open} disabled={busy || working} onClick={() => setOpen(!open)}>{working ? <LoaderCircle className="ks-spin" size={16} /> : <Download size={16} />}<span className="ks-action-text">{working ? '正在导出…' : '导出'}</span></button>{open && <div role="group" aria-label="导出格式" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 40, minWidth: 200, padding: 10, background: 'white', color: '#24476b', border: '1px solid #c7d8e7', borderRadius: 8, boxShadow: '0 8px 24px #24476b20' }}>{(['word', 'pdf', 'markdown'] as const).map(kind => <button className="ks-button" style={{ display: 'block', width: '100%', textAlign: 'left' }} type="button" disabled={working} key={kind} onClick={() => void run(kind)}>{kind === 'word' ? 'Word · 可编辑文档' : kind === 'pdf' ? 'PDF · 排版文档' : 'Markdown · 原始正文'}</button>)}<button className="ks-button" type="button" onClick={() => setOpen(false)}>关闭</button>{error && <p role="alert" style={{ color: '#a83838', fontSize: 12 }}>{error}</p>}</div>}</div>
}
