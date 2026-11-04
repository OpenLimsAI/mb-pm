import { useState } from 'react'
import { BookOpen, Link2, Quote } from 'lucide-react'
import type { Reference, Solution } from './types'
import { reportReferences, referenceEntry } from './reportReferences'
import './reportEvidence.css'

export interface ReportEvidencePanelProps {
  solution: Solution; sectionId?: string; selectedText?: string; disabled?: boolean
  onChangeReferences: (references: Reference[]) => void
  onInsertCitation: (reference: Reference) => void
  onOpenSource: (sourceId: string) => void
}
export default function ReportEvidencePanel({ solution, sectionId, selectedText, disabled, onChangeReferences, onInsertCitation, onOpenSource }: ReportEvidencePanelProps) {
  const [open, setOpen] = useState(''), [message, setMessage] = useState('')
  const numbered = reportReferences(solution)
  const refs = solution.references.filter(ref => !sectionId || ref.sectionId === sectionId)
  const update = (id: string, fields: Partial<Reference>) => onChangeReferences(solution.references.map(ref => ref.id === id ? { ...ref, ...fields } : ref))
  return <section className="ks-evidence-panel" aria-label="正文与参考依据">
    <header><h3><BookOpen size={15} />正文与参考依据</h3><span>{numbered.length} 个来源 · 本章 {refs.length} 条关联</span></header>
    <p>在结论后插入引用编号，点击编号可核对来源。绑定选段和适用条件会随报告保存。</p>
    {!refs.length && <p className="ks-muted">从知识库引用资料或采纳 AI 回答后，在这里管理依据。</p>}
    {refs.map(ref => {
      const item = numbered.find(value => value.aliases.includes(ref.id))!
      return <article key={ref.id} id={`report-reference-${encodeURIComponent(ref.id)}`}>
        <div className="ks-evidence-row"><button type="button" className="ks-evidence-title" aria-expanded={open === ref.id} onClick={() => setOpen(open === ref.id ? '' : ref.id)}>{referenceEntry({ ...item, reference: ref })}</button><button type="button" className="ks-button" onClick={() => onOpenSource(ref.sourceId)}><BookOpen size={13} />核对原文</button><button type="button" className="ks-button" disabled={disabled} onClick={() => onInsertCitation(ref)}><Link2 size={13} />插入引用</button></div>
        {open === ref.id && <div className="ks-evidence-detail"><blockquote><Quote size={14} />{ref.excerpt || '此来源未保存原文摘录，请打开资料核对。'}</blockquote>
          <label className="ks-field">关联的正文选段<textarea aria-label={`关联正文 ${ref.title}`} value={ref.anchorText || ''} readOnly rows={2} placeholder="先在正文选择一段结论，再点击绑定选中文字" /></label>
          <button type="button" className="ks-button" disabled={disabled || !selectedText?.trim() || selectedText.length > 12000 || !solution.sections.find(section => section.id === ref.sectionId)?.content.includes(selectedText)} onClick={() => { update(ref.id, { anchorText: selectedText }); setMessage('已绑定正文选段。') }}>绑定选中文字</button>
          {ref.anchorText && <button type="button" className="ks-button" disabled={disabled} onClick={() => update(ref.id, { anchorText: '' })}>解除选段关联</button>}
          <label className="ks-field">适用条件与专家判断<textarea aria-label={`适用条件 ${ref.title}`} rows={3} maxLength={2000} disabled={disabled} placeholder="记录研究对象、实验条件和结论适用范围，与来源原文分开保存" value={ref.applicability || ''} onChange={event => update(ref.id, { applicability: event.target.value })} /></label>
        </div>}
      </article>
    })}
    {message && <p role="status">{message}</p>}
  </section>
}
