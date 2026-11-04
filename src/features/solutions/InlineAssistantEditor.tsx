import { AnswerEvidence } from '../answerModes/AnswerTools'
import { useLayoutEffect, useRef, useState } from 'react'
import { moveSelectedDocumentBlock, nextCaptionNumber, captionMarkdown, reportFigureLinks } from './editorDocumentTools'
import { RichBodySegment } from './RichBodySegment'
import type { RichHandle, RichRange } from './RichBodySegment'
import { readReportImage } from './reportMarkup'
import SafeMarkdown from '../../components/SafeMarkdown'
import { GripVertical, ArrowUp, ArrowDown, Bold, BookOpen, Check, Heading2, Italic, List, LoaderCircle, Quote, Redo2, Send, Sparkles, Undo2, X, Table, ImagePlus } from 'lucide-react'
import type { NumberedReference } from './reportReferences'
import type { Answer, PolishResult, Reference } from './types'
import SelectionAssistant from './SelectionAssistant'
import type { EditorSelection } from './SelectionAssistant'
import './inlineAssistant.css'
import { findSlashTrigger, splitInlineDocument, textEditFromValues } from './inlineAssistant'
import type { InlineAnchor, InlineTextEdit } from './inlineAssistant'
import { continueEditorList, formatEditorText } from './editorFormatting'
import type { FormattedText, TextFormat } from './editorFormatting'

export interface InlineQuestion extends InlineAnchor {
  sectionId: string
  question: string
  includeContext: boolean
  status: 'idle' | 'asking' | 'answered' | 'error'
  answer?: Answer
  error?: string
  requestId?: string
}

interface Props {
  reportId?: string
  allowAI?: boolean
  references?: NumberedReference[]
  onCitation?: (reference: Reference) => void
  content: string
  onCursorChange?: (range: { from: number; to: number; text: string; content: string }) => void
  cards: InlineQuestion[]
  disabled: boolean
  scope: string
  modelLabel?: string
  preview?: boolean
  onSaveNote?: (text: string) => void
  onAskSelectedText?: (question: string, text: string) => Promise<Answer>
  onPolishSelectedText?: (text: string, instruction: string) => Promise<PolishResult>
  onAdoptSelectedAnswer?: (answer: Answer) => void
  onEdit: (edit: InlineTextEdit, precedingIds: string[]) => void
  onSelection: (text: string) => void
  onCreate: (offset: number, precedingIds: string[]) => void
  onUpdate: (id: string, patch: Partial<InlineQuestion>) => void
  onRemove: (id: string) => void
  onAsk: (id: string) => void
  onAdopt: (id: string) => void
  onSource: (id: string) => void
}

function caretLine(input: HTMLTextAreaElement) {
  const style = getComputedStyle(input), mirror = document.createElement('div'), caret = document.createElement('span')
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', width: `${input.clientWidth}px`, boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', font: style.font, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight, padding: style.padding })
  mirror.textContent = input.value.slice(0, input.selectionStart)
  caret.textContent = '|'; mirror.append(caret); document.body.append(mirror)
  const lineHeight = parseFloat(style.lineHeight) || 24
  const top = caret.offsetTop, left = caret.offsetLeft
  mirror.remove()
  return { top, left, lineHeight }
}

function keepCaretVisible(input: HTMLTextAreaElement) {
  if (document.activeElement !== input) return
  const scroll = input.closest<HTMLElement>('.ks-paper-scroll')
  if (!scroll) return
  const line = caretLine(input), bounds = scroll.getBoundingClientRect()
  const top = input.getBoundingClientRect().top + line.top
  const toolbarHeight = scroll.querySelector('.ks-editor-formatbar')?.getBoundingClientRect().height ?? 0
  if (top + line.lineHeight > bounds.bottom - 20) scroll.scrollTop += top + line.lineHeight - bounds.bottom + 20
  else if (top < bounds.top + toolbarHeight + 12) scroll.scrollTop -= bounds.top + toolbarHeight + 12 - top
}

function caretMenuTop(input: HTMLTextAreaElement) {
  const { top: caretTop, lineHeight } = caretLine(input)
  const top = caretTop - input.scrollTop + lineHeight
  const below = Math.max(24, Math.min(input.clientHeight, top))
  const viewportBottom = Math.min(window.innerHeight, input.closest('.ks-paper-scroll')?.getBoundingClientRect().bottom ?? window.innerHeight)
  return below + 150 > viewportBottom - input.getBoundingClientRect().top ? Math.max(0, below - 150 - lineHeight) : below
}

function BodySegment({ segmentKey, value, segmented, finalSegment, label, disabled, onChange, onSelection, onSelectionRange, onMenu, menuOpen, onChoose, onDismiss, onActive, onFormat, onHistory }: {
  segmentKey: string
  value: string; segmented: boolean; finalSegment: boolean; label: string; disabled: boolean
  onChange: (value: string, start: number, end: number, inputType?: string) => void; onSelection: (text: string) => void
  onSelectionRange: (input: HTMLTextAreaElement) => void
  onMenu: (offset: number | null) => void; menuOpen: boolean; onChoose: () => void; onDismiss: () => void
  onActive: (input: HTMLTextAreaElement) => void; onFormat: (format: TextFormat | 'continue', input: HTMLTextAreaElement) => boolean
  onHistory: (direction: 'undo' | 'redo') => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null), composing = useRef(false)
  const [menuTop, setMenuTop] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return
    const input = ref.current
    const resize = () => {
      const scroll = input.closest('.ks-paper-scroll'), previousTop = scroll?.scrollTop ?? 0
      input.style.height = '0px'
      input.style.height = `${Math.max(segmented ? 48 : 240, input.scrollHeight)}px`
      if (scroll) scroll.scrollTop = previousTop
      keepCaretVisible(input)
    }
    resize()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (input.clientWidth !== width) { width = input.clientWidth; resize() } })
    let width = input.clientWidth
    observer.observe(input)
    return () => observer.disconnect()
  }, [value, segmented])
  return <div className="ks-body-segment" data-final-segment={finalSegment}>
    <textarea ref={ref} data-segment-key={segmentKey} className={`ks-body-editor${segmented ? ' ks-body-fragment' : ''}`} aria-label={label} disabled={disabled} value={value}
      aria-expanded={menuOpen} aria-haspopup="menu" aria-controls={menuOpen ? 'ks-inline-slash-menu' : undefined}
      placeholder={segmented ? '继续撰写，或输入 / 提问…' : '从研究问题开始，写下观察、依据和你的判断。输入 / 插入 AI 问答…'}
      onCompositionStart={() => { composing.current = true; onDismiss() }} onCompositionEnd={() => { composing.current = false }}
      onChange={event => {
        const input = event.currentTarget, native = event.nativeEvent as InputEvent
        onChange(input.value, input.selectionStart, input.selectionEnd, native.inputType)
        const trigger = !composing.current && !native.isComposing && native.inputType === 'insertText' && native.data === '/' ? findSlashTrigger(input.value, input.selectionStart, input.selectionEnd) : null
        if (trigger) setMenuTop(caretMenuTop(input))
        onMenu(trigger?.from ?? null)
      }}
      onFocus={event => onActive(event.currentTarget)}
      onSelect={event => { const input = event.currentTarget; onActive(input); onSelection(input.value.slice(input.selectionStart, input.selectionEnd)); keepCaretVisible(input); if (!composing.current) onSelectionRange(input) }}
      onPointerUp={event => { if (!composing.current) onSelectionRange(event.currentTarget) }}
      onKeyUp={event => { if (!composing.current && (event.key === 'Shift' || event.shiftKey)) onSelectionRange(event.currentTarget) }}
      onClick={() => { if (menuOpen) onDismiss() }}
      onBlur={event => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) onDismiss() }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing) return
        if (event.key === 'Tab' && !event.shiftKey && event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
          const action = document.querySelector<HTMLButtonElement>('.ks-selection-menu button')
          if (action) { event.preventDefault(); action.focus(); return }
        }
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
          const key = event.key.toLowerCase()
          if (key === 'b' || key === 'i') { event.preventDefault(); onFormat(key === 'b' ? 'bold' : 'italic', event.currentTarget); return }
          if (key === 'z' || key === 'y') { event.preventDefault(); onHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo'); return }
        }
        if (!menuOpen) {
          if (event.key === 'Enter' && !event.shiftKey && onFormat('continue', event.currentTarget)) event.preventDefault()
          return
        }
        if (event.key === 'Escape') { event.preventDefault(); onDismiss() }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); onChoose() }
        if (event.key === 'ArrowDown') { event.preventDefault(); document.getElementById('ks-inline-ai-option')?.focus() }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) onDismiss()
      }} />
    {menuOpen && <div id="ks-inline-slash-menu" className="ks-slash-menu" style={{ top: menuTop }} role="menu" aria-label="插入功能" onKeyDown={event => { if (event.key === 'Escape') { onDismiss(); ref.current?.focus() } }}>
      <span>插入功能</span>
      <button id="ks-inline-ai-option" type="button" role="menuitem" onClick={onChoose}><Sparkles size={19} /><span><strong>AI 问答</strong><small>就地提问，选择是否采纳到报告</small></span><kbd>↵</kbd></button>
      <small>Esc 取消 · 保留斜杠</small>
    </div>}
  </div>
}

export default function InlineAssistantEditor(props: Props) {
  const { content, cards, disabled, scope, onEdit, onSelection, onCreate, onUpdate, onRemove, onAsk, onAdopt, onSource } = props
  const [mode, setMode] = useState<'visual' | 'markdown'>(() => localStorage.getItem('ks-editor-mode') === 'markdown' ? 'markdown' : 'visual')
  const rich = useRef<RichHandle | null>(null)
  const richEditors = useRef(new Map<string, RichHandle>())
  const imageInput = useRef<HTMLInputElement>(null)
  const [editorError, setEditorError] = useState('')
  const [caption, setCaption] = useState<{ kind: '图' | '表'; text: string } | null>(null)
  const [tableActive, setTableActive] = useState(false)
  const [menu, setMenu] = useState<{ key: string; offset: number } | null>(null)
  const [selectedText, setSelectedText] = useState<EditorSelection | null>(null)
  const editor = useRef<HTMLDivElement>(null), activeInput = useRef<HTMLTextAreaElement | null>(null)
  type Caret = { key: string; start: number; end: number }
  type EditStep = { before: string; after: string; beforeCaret: Caret; afterCaret: Caret; precedingIds: string[]; group: string; time: number }
  const cardIds = cards.map(card => card.id).join('|')
  const [edits, setEdits] = useState<{ content: string; cards: string; past: EditStep[]; future: EditStep[] }>({ content, cards: cardIds, past: [], future: [] })
  const pendingCaret = useRef<Caret | null>(null)
  // External insertions and card topology changes begin a new text history boundary.
  const history = edits.content === content && edits.cards === cardIds ? edits : { content, cards: cardIds, past: [], future: [] }
  const parts = splitInlineDocument(content, cards)
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (!caret) return
    const input = [...(editor.current?.querySelectorAll<HTMLTextAreaElement>('textarea[data-segment-key]') ?? [])].find(node => node.dataset.segmentKey === caret.key)
    input?.focus({ preventScroll: true }); input?.setSelectionRange(caret.start, caret.end)
    if (input) keepCaretVisible(input)
    pendingCaret.current = null
  }, [content])
  function record(partKey: string, next: FormattedText, inputType = '') {
    if (disabled) return
    const index = parts.findIndex(part => part.key === partKey), part = parts[index]
    if (!part || part.type !== 'text' || part.text === next.value) return
    setSelectedText(null)
    const edit = textEditFromValues(part.text, next.value)
    const after = content.slice(0, part.from) + next.value + content.slice(part.to)
    const precedingIds = parts.slice(0, index).filter(p => p.type === 'card').map(p => p.anchor.id)
    const step: EditStep = { before: content, after, beforeCaret: { key: part.key, start: edit.from, end: edit.to }, afterCaret: { key: part.key, start: next.start, end: next.end }, precedingIds, group: inputType && !edit.insert.includes('\n') ? `${part.key}:${inputType}` : '', time: Date.now() }
    const last = history.past.at(-1)
    const group = last && step.group && last.group === step.group && step.time - last.time < 700 && last.afterCaret.start === edit.from
    const past = group ? [...history.past.slice(0, -1), { ...step, before: last.before, beforeCaret: last.beforeCaret }] : [...history.past, step]
    setEdits({ content: after, cards: cardIds, past: past.slice(-100), future: [] })
    onEdit({ from: part.from + edit.from, to: part.from + edit.to, insert: edit.insert }, precedingIds)
  }
  function selectText(input: HTMLTextAreaElement) {
    const start = input.selectionStart, end = input.selectionEnd, text = input.value.slice(start, end)
    const part = parts.find(part => part.type === 'text' && part.key === input.dataset.segmentKey)
    if (part?.type === 'text') props.onCursorChange?.({ from: part.from + start, to: part.from + end, text, content })
    if (disabled || !text.trim()) { setSelectedText(null); return }
    const line = caretLine(input), rect = input.getBoundingClientRect()
    const bottom = Math.min(window.innerHeight, input.closest('.ks-paper-scroll')?.getBoundingClientRect().bottom || window.innerHeight)
    setMenu(null)
    setSelectedText({ key: input.dataset.segmentKey!, start, end, text, containsCitation: /\[\[cite:/.test(text), document: content, input, host: input.closest<HTMLElement>('.ks-app') || document.body,
      left: Math.max(8, Math.min(rect.left + line.left, window.innerWidth - (props.onSaveNote ? 400 : 260))), top: Math.max(8, Math.min(rect.top + line.top - input.scrollTop + line.lineHeight + 7, bottom - (props.onSaveNote && window.innerWidth < 440 ? 90 : 48))) })
  }
  function replaceSelectedText(selected: EditorSelection, replacement: string) {
    if (selected.containsCitation) return false
    if (selected.rich && mode === 'visual') {
      const target = richEditors.current.get(selected.key)
      if (disabled || content !== selected.document || !target || target.editor.isDestroyed) return false
      target.editor.chain().focus().setTextSelection({ from: selected.rich.from, to: selected.rich.to }).insertContent(replacement, { contentType: 'markdown' }).run()
      setSelectedText(null); onSelection(''); return true
    }
    const part = parts.find(part => part.type === 'text' && part.key === selected.key)
    if (disabled || content !== selected.document || !part || part.type !== 'text' || part.text.slice(selected.start, selected.end) !== selected.text) return false
    const end = selected.start + replacement.length
    pendingCaret.current = { key: selected.key, start: end, end }
    record(selected.key, { value: part.text.slice(0, selected.start) + replacement + part.text.slice(selected.end), start: end, end })
    setSelectedText(null); onSelection('')
    return true
  }
  function format(format: TextFormat | 'continue', input?: HTMLTextAreaElement): boolean {
    if (mode === 'visual' && rich.current) {
      const chain = rich.current.editor.chain().focus()
      if (format === 'heading') return chain.toggleHeading({ level: 2 }).run()
      if (format === 'bold') return chain.toggleBold().run()
      if (format === 'italic') return chain.toggleItalic().run()
      if (format === 'list') return chain.toggleBulletList().run()
      if (format === 'quote') return chain.toggleBlockquote().run()
      return false
    }
    const target = input ?? (activeInput.current?.isConnected ? activeInput.current : editor.current?.querySelector<HTMLTextAreaElement>('textarea[data-segment-key]'))
    if (disabled || !target) return false
    const next = format === 'continue' ? continueEditorList(target.value, target.selectionStart, target.selectionEnd) : formatEditorText(target.value, target.selectionStart, target.selectionEnd, format)
    if (!next) return false
    pendingCaret.current = { key: target.dataset.segmentKey!, start: next.start, end: next.end }
    setMenu(null)
    record(target.dataset.segmentKey!, next)
    onSelection(next.value.slice(next.start, next.end))
    return true
  }
  function moveHistory(direction: 'undo' | 'redo') {
    if (disabled) return
    if (mode === 'visual' && rich.current) { const chain = rich.current.editor.chain().focus(); if (direction === 'undo') chain.undo().run(); else chain.redo().run(); return }
    const undo = direction === 'undo', step = (undo ? history.past : history.future).at(-1)
    if (!step) return
    const next = undo ? step.before : step.after
    pendingCaret.current = undo ? step.beforeCaret : step.afterCaret
    setEdits({ content: next, cards: cardIds, past: undo ? history.past.slice(0, -1) : [...history.past, step], future: undo ? [...history.future, step] : history.future.slice(0, -1) })
    setMenu(null); onSelection('')
    onEdit(textEditFromValues(content, next), step.precedingIds)
  }
  function choose() { if (!menu || disabled || content[menu.offset] !== '/') return; const index = parts.findIndex(part => part.key === menu.key); onCreate(menu.offset, parts.slice(0, index).filter(part => part.type === 'card').map(part => part.anchor.id)); setMenu(null) }
  function selectRich(key: string, range: RichRange | null) {
    if (!range) { setSelectedText(null); return }
    const part = parts.find(p => p.key === key)
    if (part?.type !== 'text') return
    props.onCursorChange?.({ from: part.from + range.start, to: part.from + range.end, text: content.slice(part.from + range.start, part.from + range.end), content })
    onSelection(range.text)
    if (!range.text.trim() || disabled) { setSelectedText(null); return }
    setSelectedText({ key, start: range.start, end: range.end, text: range.text, containsCitation: /\[\[cite:/.test(part.text.slice(range.start, range.end)), document: content, rich: { from: range.from, to: range.to }, input: range.input, host: range.input.closest<HTMLElement>('.ks-app') || document.body, left: Math.max(8, Math.min(range.left, window.innerWidth - 400)), top: Math.max(8, Math.min(range.top + 7, window.innerHeight - 100)) })
  }
  async function insertImage(file?: File) {
    const target = rich.current?.editor
    if (!file || !target) return
    try { const src = await readReportImage(file); if (target.isDestroyed || !target.isEditable) return; if (content.length + src.length > 4_000_000) throw new Error('本章节图片与文字合计超过容量，请压缩图片或拆分章节。'); target.chain().focus().setImage({ src, alt: file.name }).insertContent(captionMarkdown('图', nextCaptionNumber(content, '图'), file.name.replace(/\.[^.]+$/, '')), { contentType: 'markdown' }).run(); setEditorError('') } catch (error) { setEditorError(error instanceof Error ? error.message : '图片读取失败') }
  }
  return <div className="ks-inline-editor" ref={editor}>
    <div className="ks-editor-formatbar" role="toolbar" aria-label="正文格式">
      {([{ id: 'heading', label: '标题', icon: Heading2 }, { id: 'bold', label: '加粗', icon: Bold }, { id: 'italic', label: '斜体', icon: Italic }, { id: 'list', label: '项目列表', icon: List }, { id: 'quote', label: '引用段落', icon: Quote }] as const).map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-label={label} title={`${label}${id === 'bold' ? ' · Ctrl/⌘ B' : id === 'italic' ? ' · Ctrl/⌘ I' : ''}`} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => format(id)}><Icon size={16} /></button>)}
      <span className="ks-format-divider" />
      <button type="button" aria-label="撤销正文编辑" title="撤销 · Ctrl/⌘ Z" disabled={disabled || (mode === 'markdown' && !history.past.length)} onMouseDown={event => event.preventDefault()} onClick={() => moveHistory('undo')}><Undo2 size={16} /></button>
      <button type="button" aria-label="重做正文编辑" title="重做 · Ctrl/⌘ Shift Z" disabled={disabled || (mode === 'markdown' && !history.future.length)} onMouseDown={event => event.preventDefault()} onClick={() => moveHistory('redo')}><Redo2 size={16} /></button>
      {mode === 'visual' && <><button type="button" aria-label="插入表格" title="插入 3 × 3 表格" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { rich.current?.editor.chain().focus().insertContent(captionMarkdown('表', nextCaptionNumber(content, '表'), '表格标题'), { contentType: 'markdown' }).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); setTableActive(true) }}><Table size={16} /></button><button type="button" aria-label="插入图片" title="插入 PNG / JPEG / WebP 图片，最多 1 MB" disabled={disabled} onClick={() => imageInput.current?.click()}><ImagePlus size={16} /></button><button type="button" aria-label="上移段落" title="上移当前段落、列表或表格" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { if (rich.current) moveSelectedDocumentBlock(rich.current.editor, -1) }}><ArrowUp size={16} /></button><button type="button" aria-label="下移段落" title="下移当前段落、列表或表格" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { if (rich.current) moveSelectedDocumentBlock(rich.current.editor, 1) }}><ArrowDown size={16} /></button><button type="button" aria-label="拖动当前段落" title="先把光标放在段落、列表或表格中，再拖动此手柄到目标段落前" draggable={!disabled} disabled={disabled} onDragStart={event => { const instance = rich.current?.editor; if (!instance) { event.preventDefault(); return } const selected = instance.state.selection.$from, from = selected.depth > 0 ? selected.before(1) : selected.pos; event.dataTransfer.setData('application/x-report-block', JSON.stringify({ owner: rich.current?.dragOwner, from })); event.dataTransfer.effectAllowed = 'move' }}><GripVertical size={16} /></button><button type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => setCaption({ kind: '图', text: '' })}>图表标题</button></>}
      <div className="ks-editor-mode" role="group" aria-label="编辑方式">{(['visual', 'markdown'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} onClick={() => { setMode(value); setSelectedText(null); setMenu(null); localStorage.setItem('ks-editor-mode', value) }}>{value === 'visual' ? '可视编辑' : 'Markdown'}</button>)}</div>
      <span className="ks-format-hint" hidden={props.allowAI === false}><Sparkles size={13} />输入 <kbd>/</kbd> 插入 AI 问答</span>
    </div>
    {mode === 'visual' && reportFigureLinks(content).length > 0 && <div className="ks-editor-contextbar"><label>引用图表<select aria-label="插入图表引用" value="" disabled={disabled} onChange={event => { const target = event.target.value, figure = reportFigureLinks(content).find(item => item.target === target); if (figure) rich.current?.editor.chain().focus().insertContent(`[${figure.label}](${target})`, { contentType: 'markdown' }).run() }}><option value="">选择已插入的图表</option>{reportFigureLinks(content).map(item => <option key={item.target} value={item.target}>{item.label}</option>)}</select></label></div>}
    {mode === 'visual' && tableActive && <div className="ks-editor-contextbar" role="toolbar" aria-label="表格操作"><span>表格</span>{([{ label: '增加行', action: 'addRowAfter' }, { label: '增加列', action: 'addColumnAfter' }, { label: '删除行', action: 'deleteRow' }, { label: '删除列', action: 'deleteColumn' }, { label: '合并单元格', action: 'mergeCells' }, { label: '拆分单元格', action: 'splitCell' }, { label: '删除表格', action: 'deleteTable' }] as const).map(item => <button key={item.action} type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { const current = rich.current?.editor; current?.chain().focus()[item.action]().run(); setTableActive(current?.isActive('table') || false) }}>{item.label}</button>)}</div>}
    {caption && <form className="ks-editor-caption" onSubmit={event => { event.preventDefault(); if (!caption.text.trim() || !rich.current) return; rich.current.editor.chain().focus().insertContent(captionMarkdown(caption.kind, nextCaptionNumber(content, caption.kind), caption.text.trim()), { contentType: 'markdown' }).run(); setCaption(null) }}><select aria-label="图表类型" value={caption.kind} onChange={event => setCaption({ ...caption, kind: event.target.value as '图' | '表' })}><option>图</option><option>表</option></select><input aria-label="图表标题" autoFocus value={caption.text} maxLength={200} onChange={event => setCaption({ ...caption, text: event.target.value })} placeholder="输入图表标题" /><button type="submit" disabled={!caption.text.trim()}>插入标题</button><button type="button" onClick={() => setCaption(null)}>取消</button></form>}
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择正文图片" hidden onChange={event => { void insertImage(event.target.files?.[0]); event.target.value = '' }} />
    {editorError && <p className="ks-editor-error" role="alert">{editorError}</p>}
    {parts.map((part, index) => part.type === 'text' ? mode === 'visual' ? <RichBodySegment references={props.references} onCitation={props.onCitation} key={part.key} segmented={cards.length > 0} finalSegment={index === parts.length - 1} value={part.text} label={index === 0 ? '章节正文' : `章节正文（续 ${Math.ceil(index / 2)}）`} allowAI={props.allowAI} disabled={disabled} onChange={(value, start, end) => record(part.key, { value, start, end })} onActive={handle => { rich.current = handle; richEditors.current.set(part.key, handle) }} onRange={range => { setTableActive(richEditors.current.get(part.key)?.editor.isActive('table') || false); selectRich(part.key, range) }} onError={setEditorError} onSlash={offset => onCreate(part.from + offset, parts.slice(0, index).filter(p => p.type === 'card').map(p => p.anchor.id))} /> : <BodySegment key={part.key} segmentKey={part.key} value={part.text} segmented={cards.length > 0} finalSegment={index === parts.length - 1}
      label={index === 0 ? '章节正文' : `章节正文（续 ${Math.ceil(index / 2)}）`} disabled={disabled}
      onChange={(value, start, end, inputType) => record(part.key, { value, start, end }, inputType)}
      onActive={input => { activeInput.current = input }} onFormat={format} onHistory={moveHistory}
      onSelection={onSelection} onSelectionRange={selectText} onMenu={offset => setMenu(props.allowAI === false || offset === null ? null : { key: part.key, offset: part.from + offset })}
      menuOpen={!disabled && props.allowAI !== false && menu?.key === part.key} onChoose={choose} onDismiss={() => setMenu(null)} />
      : <section key={part.key} className="ks-inline-question" aria-label="正文 AI 问答">
        <header><span><Sparkles size={16} /><strong>AI 问答</strong><small>未加入报告</small>{props.modelLabel && <small className="ks-inline-model-label">{props.modelLabel}</small>}</span><button type="button" className="ks-button" aria-label="移除问答卡片" title="移除卡片，已完成回答仍保留在助手历史中" onClick={() => onRemove(part.anchor.id)}><X size={16} /></button></header>
        <form onSubmit={event => { event.preventDefault(); onAsk(part.anchor.id) }}>
          <label className="ks-inline-question-label" htmlFor={`question-${part.key}`}>想了解什么？</label>
          <textarea id={`question-${part.key}`} autoFocus={!part.anchor.question} rows={3} maxLength={4000} placeholder="输入问题，查找相关知识与依据…" value={part.anchor.question} disabled={disabled || part.anchor.status === 'asking'} onChange={e => onUpdate(part.anchor.id, { question: e.target.value })} />
          <div className="ks-inline-question-context"><label><input type="checkbox" checked={part.anchor.includeContext} disabled={disabled || part.anchor.status === 'asking'} onChange={e => onUpdate(part.anchor.id, { includeContext: e.target.checked })} />附带本章正文（最多 5,000 字）</label><span>范围：{scope}</span></div>
          <div className="ks-inline-question-send"><small>回答经你确认后才写入报告</small><button type="submit" className="ks-button ks-primary" disabled={disabled || part.anchor.status === 'asking' || !part.anchor.question.trim()}>{part.anchor.status === 'asking' ? <><LoaderCircle size={14} className="ks-spin" />正在查找…</> : <><Send size={14} />{part.anchor.answer ? '重新提问' : '提问'}</>}</button></div>
        </form>
        {part.anchor.error && <p className="ks-error-inline" role="alert">{part.anchor.error}</p>}
        {part.anchor.answer && <div className="ks-inline-answer">
          <div className="ks-inline-answer-label"><Sparkles size={14} /><strong>{part.anchor.answer.mode === 'ai' ? 'AI 回答' : '知识库检索结果'}</strong>{part.anchor.answer.model && <small>{part.anchor.answer.model}</small>}</div>
          <p className="ks-inline-answer-question">回答对应：{part.anchor.answer.question}</p>
          <AnswerEvidence answer={part.anchor.answer} preview={props.preview} part="status" /><div className="ks-markdown"><SafeMarkdown>{part.anchor.answer.content}</SafeMarkdown></div><AnswerEvidence answer={part.anchor.answer} preview={props.preview} part="sources" referenceOrigin={props.reportId ? { originApp: 'solutions', originId: props.reportId, answerId: part.anchor.answer.id } : undefined} />
          <div className="ks-answer-citations">{part.anchor.answer.references.map((ref, n) => <button type="button" key={`${ref.id}-${n}`} onClick={() => onSource(ref.sourceId)}><BookOpen size={13} />{n + 1}. {ref.title}</button>)}</div>
          <div className="ks-inline-adopt"><button type="button" className="ks-button ks-primary" disabled={disabled || part.anchor.status === 'asking'} onClick={() => onAdopt(part.anchor.id)}><Check size={14} />采纳到报告</button><button type="button" className="ks-button" onClick={() => onRemove(part.anchor.id)}>不采纳，移除卡片</button></div>
        </div>}
        <footer>卡片仅在本次编辑中保留；已完成回答可在 AI 研究助手中查看。</footer>
      </section>)}
    {props.allowAI !== false && props.onAskSelectedText && props.onPolishSelectedText && props.onAdoptSelectedAnswer && <SelectionAssistant reportId={props.reportId} selection={!disabled && selectedText?.document === content ? selectedText : null} onSaveNote={props.onSaveNote} preview={props.preview} modelLabel={props.modelLabel} scope={scope} onDismiss={() => setSelectedText(null)} onAsk={props.onAskSelectedText} onPolish={props.onPolishSelectedText} onAdopt={props.onAdoptSelectedAnswer} onReplace={replaceSelectedText} onSource={onSource} />}
  </div>
}
