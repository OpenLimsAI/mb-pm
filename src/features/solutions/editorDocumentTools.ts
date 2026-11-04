import type { Editor } from '@tiptap/react'

/** Move a complete top-level paragraph/list/table without reserializing the document. */
export function moveDocumentBlock(editor: Editor, from: number, target: number): boolean {
  const nodes: { from: number; size: number }[] = []
  editor.state.doc.forEach((node, offset) => nodes.push({ from: offset, size: node.nodeSize }))
  const block = nodes.find(node => node.from === from)
  if (!block || target === from || target === from + block.size || target < 0 || target > editor.state.doc.content.size) return false
  const node = editor.state.doc.nodeAt(from)
  if (!node) return false
  const transaction = editor.state.tr.delete(from, from + block.size)
  transaction.insert(target > from ? target - block.size : target, node)
  editor.view.dispatch(transaction.scrollIntoView())
  return true
}
export function moveSelectedDocumentBlock(editor: Editor, direction: -1 | 1): boolean {
  const nodes: { from: number; size: number }[] = []
  editor.state.doc.forEach((node, offset) => nodes.push({ from: offset, size: node.nodeSize }))
  const selected = editor.state.selection.$from, from = selected.depth > 0 ? selected.before(1) : selected.pos
  const index = nodes.findIndex(node => node.from === from), adjacent = nodes[index + direction]
  if (index < 0 || !adjacent) return false
  return moveDocumentBlock(editor, from, direction < 0 ? adjacent.from : adjacent.from + adjacent.size)
}
export function nextCaptionNumber(markdown: string, kind: '图' | '表'): number {
  const numbers = [...markdown.matchAll(new RegExp(`(?:^|\\n)\\[?${kind}\\s*(\\d+)[\\s：:.、]`, 'g'))].map(match => Number(match[1]))
  return Math.max(0, ...numbers) + 1
}
export function captionMarkdown(kind: '图' | '表', number: number, title: string, id: string = crypto.randomUUID()): string {
  return `[${kind} ${number}\u3000${title.replace(/[[\]\r\n]/g, '').trim()}](#report-${kind === '图' ? 'figure' : 'table'}-${id})`
}
export function reportFigureLinks(markdown: string): { label: string; target: string }[] {
  return [...markdown.matchAll(/\[([图表]\s*\d+)[\u3000 ]+[^\]]+\]\((#report-(?:figure|table)-[\w-]+)\)/g)].map(match => ({ label: match[1], target: match[2] }))
}
/** Reused chapters get fresh caption IDs; links to captions defined elsewhere remain intact. */
export function remapCopiedFigureAnchors(markdown: string, id: () => string = () => crypto.randomUUID()): string {
  const replacements = new Map(reportFigureLinks(markdown).map(link => [link.target, link.target.replace(/(figure|table)-[\w-]+$/, (_match, kind: string) => `${kind}-${id()}`)]))
  return markdown.replace(/#report-(?:figure|table)-[\w-]+/g, token => replacements.get(token) || token)
}
