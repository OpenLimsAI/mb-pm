import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { Bold, ImagePlus, Italic, Link2, List, ListOrdered, Quote, Redo2, Strikethrough, Table, Undo2 } from 'lucide-react'
import { RichBodySegment } from '../solutions/RichBodySegment'
import type { RichHandle } from '../solutions/RichBodySegment'
import { readReportImage } from '../solutions/reportMarkup'
import { safeMarkdownLink } from '../../components/markdownSafety'
import './note-rich-editor.css'

export default function NoteRichEditor({ value, onChange, disabled, onBusyChange }: { value: string; onChange: (value: string) => void; disabled: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [mode, setMode] = useState<'visual' | 'markdown'>('visual')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [link, setLink] = useState<string | null>(null), [error, setError] = useState('')
  const [readingImage, setReadingImage] = useState(false)
  const alive = useRef(true), imagePending = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const imageInput = useRef<HTMLInputElement>(null)
  const active = useCallback((handle: RichHandle) => setEditor(handle.editor), [])
  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    heading: [1, 2, 3].find(level => current.isActive('heading', { level })) || 0,
    bold: current.isActive('bold'), italic: current.isActive('italic'), strike: current.isActive('strike'),
    bulletList: current.isActive('bulletList'), orderedList: current.isActive('orderedList'),
    blockquote: current.isActive('blockquote'), link: current.isActive('link'), table: current.isActive('table'),
    undo: current.can().undo(), redo: current.can().redo(),
  } : null })
  const unavailable = disabled || readingImage || !editor || editor.isDestroyed
  const command = (run: (current: Editor) => void) => { if (!unavailable && editor) { setError(''); run(editor) } }
  async function insertImage(file?: File) {
    if (!file || unavailable || imagePending.current || !editor) return
    const current = editor
    imagePending.current = true; setReadingImage(true); onBusyChange?.(true)
    try {
      const src = await readReportImage(file)
      if (current.isDestroyed || !current.isEditable) return
      if (current.getMarkdown().length + src.length + file.name.length + 10 > 50000) throw new Error('图片与文字合计超过笔记容量，请压缩图片后重试。')
      current.chain().focus().setImage({ src, alt: file.name }).run()
      setError('')
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '图片读取失败，请重试。') }
    finally { imagePending.current = false; if (alive.current) { setReadingImage(false); onBusyChange?.(false) } }
  }
  function applyLink() {
    if (link === null || unavailable) return
    const href = link.trim()
    if (href && !safeMarkdownLink(href)) { setError('请输入 http 或 https 链接，或以 /、# 开头的站内链接。'); return }
    command(current => { const chain = current.chain().focus().extendMarkRange('link'); if (href) chain.setLink({ href }).run(); else chain.unsetLink().run() })
    setLink(null)
  }
  return <div className="pn-document-editor" data-mode={mode}>
    <div className="pn-document-toolbar" role="toolbar" aria-label="笔记正文格式">
      {mode === 'visual' && <>
        <button type="button" aria-label="撤销" title="撤销 · Ctrl/⌘ Z" disabled={unavailable || !state?.undo} onMouseDown={event => event.preventDefault()} onClick={() => command(current => { current.chain().focus().undo().run() })}><Undo2 size={16} /></button>
        <button type="button" aria-label="重做" title="重做 · Ctrl/⌘ Shift Z" disabled={unavailable || !state?.redo} onMouseDown={event => event.preventDefault()} onClick={() => command(current => { current.chain().focus().redo().run() })}><Redo2 size={16} /></button>
        <span className="pn-format-divider" />
        <select aria-label="段落样式" value={state?.heading || 0} disabled={unavailable} onChange={event => { const level = Number(event.target.value); command(current => { const chain = current.chain().focus(); if (level) chain.setHeading({ level: level as 1 | 2 | 3 }).run(); else chain.setParagraph().run() }) }}>
          <option value={0}>正文</option><option value={1}>标题 1</option><option value={2}>标题 2</option><option value={3}>标题 3</option>
        </select>
        <span className="pn-format-divider" />
        {([
          { label: '加粗', key: 'bold', icon: Bold, run: (current: Editor) => current.chain().focus().toggleBold().run() },
          { label: '斜体', key: 'italic', icon: Italic, run: (current: Editor) => current.chain().focus().toggleItalic().run() },
          { label: '删除线', key: 'strike', icon: Strikethrough, run: (current: Editor) => current.chain().focus().toggleStrike().run() },
          { label: '项目列表', key: 'bulletList', icon: List, run: (current: Editor) => current.chain().focus().toggleBulletList().run() },
          { label: '编号列表', key: 'orderedList', icon: ListOrdered, run: (current: Editor) => current.chain().focus().toggleOrderedList().run() },
          { label: '引用段落', key: 'blockquote', icon: Quote, run: (current: Editor) => current.chain().focus().toggleBlockquote().run() },
        ] as const).map(({ label, key, icon: Icon, run }) => <button key={key} type="button" aria-label={label} title={label} aria-pressed={state?.[key] || false} disabled={unavailable} onMouseDown={event => event.preventDefault()} onClick={() => command(run)}><Icon size={16} /></button>)}
        <span className="pn-format-divider" />
        <button type="button" aria-label="插入链接" title="插入或编辑链接" aria-pressed={state?.link || false} disabled={unavailable} onMouseDown={event => event.preventDefault()} onClick={() => { setLink(editor?.getAttributes('link').href || ''); setError('') }}><Link2 size={16} /></button>
        <button type="button" aria-label="插入表格" title="插入 3 × 3 表格" disabled={unavailable} onMouseDown={event => event.preventDefault()} onClick={() => command(current => { current.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() })}><Table size={16} /></button>
        <button type="button" aria-label="插入图片" title="插入图片（计入笔记容量）" disabled={unavailable || readingImage} onMouseDown={event => event.preventDefault()} onClick={() => imageInput.current?.click()}><ImagePlus size={16} /></button>
      </>}
      <div className="pn-document-mode" role="group" aria-label="编辑方式">{(['visual', 'markdown'] as const).map(next => <button type="button" key={next} disabled={disabled || readingImage} aria-pressed={mode === next} onClick={() => { setMode(next); if (next === 'markdown') setEditor(null); setLink(null); setError('') }}>{next === 'visual' ? '可视编辑' : 'Markdown'}</button>)}</div>
    </div>
    {mode === 'visual' && state?.table && <div className="pn-document-context" role="toolbar" aria-label="表格操作">{([
      { label: '增加行', action: 'addRowAfter' }, { label: '增加列', action: 'addColumnAfter' },
      { label: '删除行', action: 'deleteRow' }, { label: '删除列', action: 'deleteColumn' },
      { label: '合并单元格', action: 'mergeCells' }, { label: '拆分单元格', action: 'splitCell' }, { label: '删除表格', action: 'deleteTable' },
    ] as const).map(({ label, action }) => <button type="button" key={action} disabled={unavailable} onMouseDown={event => event.preventDefault()} onClick={() => command(current => { current.chain().focus()[action]().run() })}>{label}</button>)}</div>}
    {link !== null && mode === 'visual' && <div className="pn-document-link" role="group" aria-label="编辑链接">
      <input aria-label="链接地址" autoFocus value={link} disabled={disabled} placeholder="https://…" onChange={event => setLink(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyLink() }; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setLink(null); editor?.commands.focus() } }} />
      <button type="button" disabled={unavailable} onClick={applyLink}>应用链接</button><button type="button" disabled={disabled} onClick={() => { setLink(null); editor?.commands.focus() }}>取消</button>
    </div>}
    <input ref={imageInput} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择笔记图片" onChange={event => { void insertImage(event.target.files?.[0]); event.target.value = '' }} />
    {error && <p className="pn-document-error" role="alert">{error}</p>}
    <div className="pn-document-paper">
      {readingImage && <p className="pn-document-status" role="status">正在插入图片…</p>}
      {mode === 'visual' ? <RichBodySegment value={value} label="笔记正文" disabled={disabled} allowAI={false} placeholder="写下摘录、观察与想法…" maxContentLength={50000} onChange={onChange} onActive={active} onRange={() => {}} onSlash={() => {}} onError={setError} onImage={file => { void insertImage(file) }} />
        : <textarea aria-label="笔记正文" className="pn-markdown-source" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder="使用 Markdown 编辑笔记…" spellCheck={false} />}
    </div>
  </div>
}
