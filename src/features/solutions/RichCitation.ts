import { Node } from '@tiptap/core'
import { citationToken } from './reportReferences'
import type { NumberedReference } from './reportReferences'
import type { Reference } from './types'

/** A stable stored identifier is rendered as a small numbered atom in the writing surface. */
export function richCitation(initialReferences: NumberedReference[], initialOnOpen?: (reference: Reference) => void) {
  let references = initialReferences, onOpen = initialOnOpen
  const entry = (id: string) => references.find(item => item.aliases.includes(id))
  return Node.create({
    name: 'reportCitation', inline: true, group: 'inline', atom: true, selectable: true,
    addAttributes() { return { referenceId: { default: '', parseHTML: element => element.getAttribute('data-report-cite'), rendered: false } } },
    parseHTML() { return [{ tag: 'span[data-report-cite]' }] },
    renderHTML({ node }) { const item = entry(node.attrs.referenceId); return ['span', { 'data-report-cite': node.attrs.referenceId, class: 'ks-rich-citation' }, `[${item?.number || '?'}]`] },
    renderText({ node }) { return `[${entry(node.attrs.referenceId)?.number || '?'}]` },
    markdownTokenizer: {
      name: 'reportCitation', level: 'inline', start: '[[cite:',
      tokenize(src) { const match = src.match(/^\[\[cite:([^\]\n]+)\]\]/); if (!match) return undefined; return { type: 'reportCitation', raw: match[0], text: match[1] } },
    },
    parseMarkdown(token, helpers) { let referenceId = token.text || ''; try { referenceId = decodeURIComponent(referenceId) } catch { /* Unknown identifiers remain visibly unresolved. */ } return helpers.createNode('reportCitation', { referenceId }) },
    renderMarkdown(node) { return citationToken(String(node.attrs?.referenceId || '')) },
    addNodeView() {
      return ({ node, view }) => {
        let current = node
        const dom = document.createElement('span'), button = document.createElement('button')
        dom.contentEditable = 'false'; dom.className = 'ks-rich-citation'; button.type = 'button'; dom.append(button)
        function refresh() {
          const item = entry(current.attrs.referenceId)
          button.textContent = `[${item?.number || '?'}]`
          button.title = item ? `核对原文：${item.reference.title}` : '此引用的来源待核对'
          button.setAttribute('aria-label', item ? `引用 ${item.number}：${item.reference.title}` : '引用来源待核对')
          dom.dataset.reportCite = current.attrs.referenceId
        }
        button.addEventListener('click', event => { event.preventDefault(); const item = entry(current.attrs.referenceId); if (item) onOpen?.(item.reference) })
        const refreshEvent = (event: Event) => { const detail = (event as CustomEvent<{ references: NumberedReference[]; onCitation?: (reference: Reference) => void }>).detail; if (detail) { references = detail.references; onOpen = detail.onCitation }; refresh() }
        view.dom.addEventListener('report-citations-change', refreshEvent)
        refresh()
        return { dom, update(next) { if (next.type.name !== 'reportCitation') return false; current = next; refresh(); return true }, stopEvent: event => event.target === button, ignoreMutation: () => true, destroy() { view.dom.removeEventListener('report-citations-change', refreshEvent) } }
      }
    },
  })
}
