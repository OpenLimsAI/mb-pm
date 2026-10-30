import { useEffect, useRef, useState } from 'react'
import { FileText, LoaderCircle, Upload } from 'lucide-react'
import { parseReportFile, REPORT_IMPORT_ACCEPT } from './reportImport'
import type { ImportedReport } from './reportImport'
import type { SolutionInput } from './types'
import './reportImport.css'

export default function ReportImportForm({ busy, error, onCancel, onImport }: {
  busy: boolean; error: string; onCancel: () => void; onImport: (input: SolutionInput) => Promise<void>
}) {
  const [parsed, setParsed] = useState<ImportedReport | null>(null)
  const [parsing, setParsing] = useState(false), [problem, setProblem] = useState(''), [title, setTitle] = useState('')
  const input = useRef<HTMLInputElement>(null), request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  async function choose(file?: File) {
    if (!file) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setParsing(true); setParsed(null); setProblem(''); setTitle('')
    try {
      const result = await parseReportFile(file, controller.signal)
      if (controller.signal.aborted) return
      setParsed(result); setTitle(result.input.title)
    } catch (reason) {
      if (!controller.signal.aborted) setProblem(reason instanceof Error ? reason.message : '文件无法读取，请重试。')
    } finally { if (!controller.signal.aborted) setParsing(false) }
  }
  return <form className="ks-report-import" onSubmit={event => {
    event.preventDefault()
    if (parsed && title.trim() && !busy && !parsing) void onImport({ ...parsed.input, title: title.trim() })
  }}>
    <p className="ks-import-intro">从已有文档开始撰写，确认预览后创建一份新报告。</p>
    <input ref={input} type="file" accept={REPORT_IMPORT_ACCEPT} aria-label="选择报告文件" hidden disabled={busy} onChange={event => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      void choose(file)
    }} />
    <button type="button" className={`ks-import-picker ${parsed ? 'has-preview' : ''}`} disabled={busy} onClick={() => input.current?.click()}>
      {parsing ? <LoaderCircle className="ks-spin" size={26} /> : <Upload size={26} />}
      <strong>{parsing ? '正在读取文档…' : parsed ? '重新选择文件' : '选择要导入的文档'}</strong>
      <span>Word .docx · PDF .pdf · Markdown .md / .markdown</span>
      <small>单个文件最大 20 MB</small>
    </button>
    {(problem || error) && <p className="ks-import-error" role="alert">{problem || error}</p>}
    {parsed && <div className="ks-import-preview">
      <div className="ks-import-file"><FileText size={16} /><strong>{parsed.fileName}</strong><span>{parsed.characters.toLocaleString()} 字 · {parsed.input.sections.length} 个章节</span></div>
      <label>报告名称<input required maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <label>正文预览<textarea aria-label="导入正文预览" readOnly value={parsed.input.sections.map(section => section.content).join('')} /></label>
      <p className="ks-import-note">{parsed.kind === 'markdown' ? '保留 Markdown 标记。' : parsed.kind === 'pdf' ? '提取 PDF 中的文字，不保留图片和原版式；扫描件需先进行文字识别。' : '提取正文文字，不保留图片、原版式和复杂表格。'}{parsed.input.sections.length > 1 && ' 较长正文已分为续章。'}</p>
    </div>}
    <footer><span className="ks-import-note">当前报告会保留。</span><button type="button" className="ks-button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="ks-button ks-primary" disabled={!parsed || !title.trim() || parsing || busy}>{busy && <LoaderCircle size={14} className="ks-spin" />}{busy ? '正在导入…' : '导入为新报告'}</button></footer>
  </form>
}
