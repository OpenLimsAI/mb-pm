import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { htmlToReportMarkdown, safeReportImage } from './reportMarkup'
import { getRange } from './richSelection'
import './richEditor.css'

export type RichRange = { start: number; end: number; text: string; from: number; to: number; left: number; top: number; input: HTMLElement }
export interface RichHandle { editor: Editor; range: () => RichRange | null }
const SafeImage = Image.extend({
  addAttributes() { return { ...this.parent?.(), src: { default: null, parseHTML: element => safeReportImage(element.getAttribute('src') || '') ? element.getAttribute('src') : null } } },
  renderHTML({ HTMLAttributes }) {
    if (!safeReportImage(HTMLAttributes.src || '')) return ['span', { class: 'ks-image-placeholder', contenteditable: 'false' }, `[图片：${HTMLAttributes.alt || '外部图片未加载'}]`]
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)]
  },
}).configure({ allowBase64: true })

export function RichBodySegment({ value, label, disabled, segmented = false, finalSegment = true, onChange, onRange, onActive, onSlash }: {
  value: string; label: string; disabled: boolean; segmented?: boolean; finalSegment?: boolean
  onChange: (value: string, start: number, end: number) => void
  onRange: (range: RichRange | null) => void
  onActive: (handle: RichHandle) => void
  onSlash: (offset: number) => void
}) {
  const placeholder = segmented ? '继续撰写，或输入 / 提问…' : '从研究问题开始，写下观察、依据和你的判断。输入 / 插入 AI 问答…'
  const latest = useRef({ value, onChange, onRange, onActive, onSlash })
  useEffect(() => { latest.current = { value, onChange, onRange, onActive, onSlash } })
  const slashRef = useRef<number | null>(null)
  const [slash, setSlash] = useState<number | null>(null)
  useEffect(() => { slashRef.current = slash }, [slash])
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, protocols: ['https', 'http', 'mailto'] } }), TableKit.configure({ table: { resizable: true } }), SafeImage, Markdown],
    content: value, contentType: 'markdown', editable: !disabled,
    editorProps: { attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'data-placeholder': placeholder, class: 'ks-rich-document' },
      handlePaste(view, event) {
        const html = event.clipboardData?.getData('text/html')
        if (!html) return false
        event.preventDefault()
        const md = htmlToReportMarkdown(html)
        const current = view.dom.closest('.ks-rich-segment')
        const instance = current && handles.get(current)
        if (instance) instance.commands.insertContent(md, { contentType: 'markdown' })
        return true
      },
      handleKeyDown(view, event) {
        if (event.isComposing || view.composing) return false
        if (slashRef.current !== null && ['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); latest.current.onSlash(slashRef.current); setSlash(null); return true }
        if (event.key === 'Escape') { setSlash(null); return false }
        return false
      },
    },
    onUpdate({ editor: instance, transaction }) {
      const md = instance.getMarkdown()
      const range = getRange(instance, md)
      latest.current.onChange(md, range?.start ?? md.length, range?.end ?? md.length)
      if (transaction.docChanged && range && md[range.start - 1] === '/' && !instance.view.composing) setSlash(range.start - 1)
      else setSlash(null)
    },
    onSelectionUpdate({ editor: instance }) { latest.current.onRange(getRange(instance, latest.current.value)) },
    onFocus({ editor: instance }) { latest.current.onActive({ editor: instance, range: () => getRange(instance, latest.current.value) }); latest.current.onRange(getRange(instance, latest.current.value)) },
  })
  const empty = useEditorState({ editor, selector: ({ editor: current }) => current?.isEmpty ?? false })
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!editor || !host.current) return; const element = host.current; handles.set(element, editor); latest.current.onActive({ editor, range: () => getRange(editor, latest.current.value) }); return () => { handles.delete(element) } }, [editor])
  useEffect(() => { if (editor && !editor.view.composing) { if (editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false }); if (editor.isFocused) latest.current.onRange(getRange(editor, value)) } }, [editor, value])
  useEffect(() => { editor?.setEditable(!disabled, false) }, [editor, disabled])
  useEffect(() => { if (editor) editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'data-placeholder': placeholder, class: 'ks-rich-document' } } }) }, [editor, label, placeholder])
  return <div className={`ks-body-segment ks-rich-segment${segmented ? ' ks-rich-fragment' : ''}`} data-final-segment={finalSegment} data-empty={empty} ref={host}><EditorContent className="ks-rich-content" editor={editor} />{slash !== null && !disabled && <div className="ks-rich-slash" role="menu" aria-label="插入功能"><button type="button" role="menuitem" onMouseDown={event => event.preventDefault()} onClick={() => { onSlash(slash); setSlash(null) }}>✦ AI 问答 · 在此提问</button><button type="button" aria-label="取消插入功能" onClick={() => setSlash(null)}>×</button></div>}</div>
}
const handles = new WeakMap<Element, Editor>()

