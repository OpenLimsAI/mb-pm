import { AnswerEvidence } from '../answerModes/AnswerTools'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowRight, BookOpen, Check, LoaderCircle, MessageSquare, NotebookPen, Sparkles, WandSparkles, X } from 'lucide-react'
import type { Answer, PolishResult } from './types'
import { preserveSelectionWhitespace } from './editorFormatting'
import './selectionAssistant.css'

export interface EditorSelection {
  key: string
  start: number
  end: number
  text: string
  document: string
  left: number
  top: number
  host: HTMLElement
  input: HTMLElement
  rich?: { from: number; to: number }
}
type Action = 'ask' | 'polish'
interface Props {
  selection: EditorSelection | null
  modelLabel?: string
  preview?: boolean
  scope: string
  onSaveNote?: (text: string) => void
  onDismiss: () => void
  onAsk: (question: string, text: string) => Promise<Answer>
  onPolish: (text: string, instruction: string) => Promise<PolishResult>
  onReplace: (selection: EditorSelection, text: string) => boolean
  onAdopt: (answer: Answer) => void
  onSource: (id: string) => void
}

export default function SelectionAssistant({ selection, modelLabel, preview, scope, onSaveNote, onDismiss, onAsk, onPolish, onReplace, onAdopt, onSource }: Props) {
  const [session, setSession] = useState<{ action: Action; selection: EditorSelection } | null>(null)
  const [question, setQuestion] = useState('这段内容有哪些相关知识与依据？'), [instruction, setInstruction] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null), [polish, setPolish] = useState<PolishResult | null>(null), [suggestion, setSuggestion] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dialog = useRef<HTMLDivElement>(null), generation = useRef(0)
  const close = () => { generation.current += 1; setSession(null); setBusy(false); setError('') }
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close })
  useEffect(() => () => { generation.current += 1 }, [])
  useEffect(() => {
    if (!selection || session) return
    const dismiss = (event: Event) => {
      if (event.type === 'focusin' && event.target === selection.input) return
      if (event.type === 'pointerdown' && event.target instanceof Element && event.target.closest('.ks-selection-menu')) return
      if (event.type === 'focusin' && event.target instanceof Element && event.target.closest('.ks-selection-menu')) return
      onDismiss()
    }
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onDismiss() } }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('scroll', dismiss, true)
    document.addEventListener('keydown', keyboard)
    window.addEventListener('resize', dismiss)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss); document.removeEventListener('scroll', dismiss, true); document.removeEventListener('keydown', keyboard); window.removeEventListener('resize', dismiss) }
  }, [selection, session, onDismiss])
  useEffect(() => {
    if (!session) return
    const previous = document.activeElement as HTMLElement | null, element = dialog.current
    element?.focus({ preventScroll: true })
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
      if (event.key !== 'Tab' || !element) return
      const controls = [...element.querySelectorAll<HTMLElement>('button:not([disabled]),textarea:not([disabled]),input:not([disabled])')]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [session])
  function open(action: Action, selected: EditorSelection) {
    generation.current += 1
    setSession({ action, selection: selected }); setAnswer(null); setPolish(null); setSuggestion(''); setError(''); setBusy(false)
    onDismiss()
  }
  async function generate() {
    if (!session || busy || session.selection.text.length > 5000 || (session.action === 'ask' && !question.trim())) return
    const current = ++generation.current
    setBusy(true); setError(''); setAnswer(null); setPolish(null); setSuggestion('')
    try {
      if (session.action === 'ask') {
        const result = await onAsk(question.trim(), session.selection.text)
        if (current === generation.current) setAnswer(result)
      } else {
        const result = await onPolish(session.selection.text, instruction.trim())
        if (current === generation.current) { setPolish(result); setSuggestion(preserveSelectionWhitespace(session.selection.text, result.content)) }
      }
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : '处理未完成，请重试。') }
    finally { if (current === generation.current) setBusy(false) }
  }
  const target = session?.selection.host || selection?.host
  if (!target) return null
  return createPortal(<>
    {selection && !session && <div className="ks-selection-menu" role="toolbar" aria-label="选中文字操作" style={{ left: selection.left, top: selection.top }}>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => open('ask', selection)}><MessageSquare size={15} />询问 AI</button>
      <span />
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => open('polish', selection)}><WandSparkles size={15} />Polish 文字</button>
      {onSaveNote && <><span /><button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { onSaveNote(selection.text); onDismiss() }}><NotebookPen size={15} />存入我的笔记</button></>}
    </div>}
    {session && <div className="ks-overlay ks-selection-overlay" onMouseDown={event => { if (event.currentTarget === event.target) close() }}>
      <div className="ks-modal ks-modal-wide ks-selection-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={session.action === 'ask' ? '询问 AI · 选中文字' : 'Polish 文字 · 润色'} tabIndex={-1}>
        <header><div><Sparkles size={18} /><h2>{session.action === 'ask' ? '询问 AI' : 'Polish 文字'}</h2><span>围绕选中的 {session.selection.text.length.toLocaleString()} 字</span></div><button type="button" className="ks-button" aria-label="关闭选中文字助手" onClick={close}><X size={18} /></button></header>
        <div className="ks-selection-tabs" role="group" aria-label="文字助手功能">
          <button type="button" aria-pressed={session.action === 'ask'} disabled={busy} onClick={() => open('ask', session.selection)}><MessageSquare size={15} />询问 AI</button>
          <button type="button" aria-pressed={session.action === 'polish'} disabled={busy} onClick={() => open('polish', session.selection)}><WandSparkles size={15} />Polish 文字</button>
        </div>
        <div className="ks-selection-original"><span>选中原文</span><blockquote>{session.selection.text}</blockquote></div>
        <div className="ks-selection-model"><Sparkles size={13} />{preview ? '本地演示' : modelLabel || '企业默认模型'}<span>{session.action === 'ask' ? `资料范围：${scope}` : '仅润色选中文字，保留事实、数值与限定条件'}</span></div>
        {preview && <p className="ks-selection-preview-note">{session.action === 'ask' ? '预览仅演示回答方式和来源展示，不调用外部模型或联网搜索。' : '预览仅演示空格与标点整理，不调用外部模型；可编辑建议，体验替换与撤销。'}</p>}
        <form onSubmit={event => { event.preventDefault(); void generate() }}>
          <label className="ks-field">{session.action === 'ask' ? '想了解什么？' : '润色要求（可选）'}<textarea aria-label={session.action === 'ask' ? '关于选中文字的问题' : '润色要求'} rows={2} maxLength={session.action === 'ask' ? 4000 : 1000} disabled={busy} value={session.action === 'ask' ? question : instruction} placeholder={session.action === 'ask' ? '输入问题，选中原文会自动附带…' : '例如：表达更简洁，使用正式的研究报告语气'} onChange={event => session.action === 'ask' ? setQuestion(event.target.value) : setInstruction(event.target.value)} /></label>
          <div className="ks-selection-generate"><small>结果经你确认后才写入报告</small><button type="submit" className="ks-button ks-primary" disabled={busy || session.selection.text.length > 5000 || (session.action === 'ask' && !question.trim())}>{busy ? <><LoaderCircle size={14} className="ks-spin" />处理中…</> : <>{session.action === 'ask' ? '发送问题' : polish ? '重新润色' : '开始润色'}<ArrowRight size={14} /></>}</button></div>
        </form>
        {session.selection.text.length > 5000 && <p className="ks-error-inline" role="alert">每次最多处理 5,000 字，请缩短选区后重试。</p>}
        {error && <p className="ks-error-inline" role="alert">{error}</p>}
        <div aria-live="polite">
          {answer && <section className="ks-selection-result" aria-label="选中文字问答结果"><div className="ks-selection-result-heading"><strong>{answer.mode === 'ai' ? 'AI 回答' : '资料检索结果'}</strong><span>{answer.model}</span></div><AnswerEvidence answer={answer} preview={preview} part="status" /><div className="ks-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.content}</ReactMarkdown></div><AnswerEvidence answer={answer} preview={preview} part="sources" /><div className="ks-answer-citations">{answer.references.map((ref, index) => <button type="button" key={ref.id || index} onClick={() => { close(); onSource(ref.sourceId) }}><BookOpen size={12} />{index + 1}. {ref.title}</button>)}</div></section>}
          {polish && <section className="ks-selection-result" aria-label="润色建议"><label className="ks-field">润色后 · 可继续修改<textarea aria-label="润色后的文字" rows={6} value={suggestion} onChange={event => setSuggestion(event.target.value)} /></label><small>{polish.mode === 'preview' ? '本地演示' : polish.model} · 采纳前请核对原意、数值和限定条件。</small></section>}
        </div>
        <footer><button type="button" className="ks-button" onClick={close}>保留原文</button>{answer && <button type="button" className="ks-button ks-primary" onClick={() => { close(); onAdopt(answer) }}><Check size={14} />插入报告…</button>}{polish && <button type="button" className="ks-button ks-primary" disabled={!suggestion.trim() || busy} onClick={() => { if (onReplace(session.selection, preserveSelectionWhitespace(session.selection.text, suggestion))) close(); else setError('原文已发生变化，请关闭窗口并重新选择文字，避免覆盖后续编辑。') }}><Check size={14} />替换选中文字</button>}</footer>
      </div>
    </div>}
  </>, target)
}
