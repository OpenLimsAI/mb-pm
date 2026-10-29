import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { NotebookPen } from 'lucide-react'
import type { RefObject } from 'react'
import './notes.css'

export default function NoteSelectionCapture({ root, selector, onCapture }: {
  root: RefObject<HTMLElement | null>; selector: string; onCapture: (text: string, element: Element) => void
}) {
  const [selected, setSelected] = useState<{ text: string; element: Element; left: number; top: number } | null>(null)
  useEffect(() => {
    const capture = (event: Event) => {
      if (document.querySelector('.pn-overlay') || event instanceof KeyboardEvent && event.key === 'Escape') { setSelected(null); return }
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setSelected(null); return }
      const range = selection.getRangeAt(0), node = range.commonAncestorContainer
      const element = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest(selector)
      const text = selection.toString()
      if (!element || !root.current?.contains(element) || !root.current.contains(range.startContainer) || !root.current.contains(range.endContainer) || !text.trim()) { setSelected(null); return }
      const rect = range.getBoundingClientRect()
      setSelected({ text, element, left: Math.max(8, Math.min(innerWidth - 180, rect.left)), top: Math.max(8, Math.min(innerHeight - 50, rect.top < 55 ? rect.bottom + 8 : rect.top - 48)) })
    }
    const dismiss = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('.pn-selection-menu'))) setSelected(null) }
    document.addEventListener('mouseup', capture)
    document.addEventListener('keyup', capture)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => { document.removeEventListener('mouseup', capture); document.removeEventListener('keyup', capture); document.removeEventListener('pointerdown', dismiss); document.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss) }
  }, [root, selector])
  return selected ? createPortal(<div className="pn-selection-menu" role="toolbar" aria-label="选中文字笔记操作" style={{ left: selected.left, top: selected.top }}><button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { onCapture(selected.text, selected.element); setSelected(null) }}><NotebookPen size={16} />存入我的笔记</button></div>, document.body) : null
}
