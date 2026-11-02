/** Print-sized pages, constructed from DOM blocks before canvas rendering. No full-document canvas. */
export const PDF_CONTENT_HEIGHT = 980
export function paginateReport(article: HTMLElement, container: HTMLElement): HTMLElement[] {
  const pages: HTMLElement[] = []
  let body: HTMLElement
  function newPage() {
    const page = document.createElement('div')
    page.style.cssText = 'width:794px;min-height:1123px;padding:48px;box-sizing:border-box;background:white;color:#243746;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.7;overflow-wrap:anywhere;'
    body = document.createElement('div'); body.style.display = 'flow-root'; page.append(body); container.append(page); pages.push(page)
  }
  newPage()
  function fits(node: HTMLElement) { body.append(node); const height = body.getBoundingClientRect().height; node.remove(); return height <= PDF_CONTENT_HEIGHT }
  function append(node: HTMLElement) {
    if (fits(node)) { body.append(node); return }
    if (body.childNodes.length) {
      const previous = body.lastElementChild as HTMLElement | null
      if (previous && /^H[1-6]$/.test(previous.tagName)) { previous.remove(); newPage(); body.append(previous) }
      else newPage()
    }
    if (fits(node)) { body.append(node); return }
    // A single paragraph may be longer than a page. Split DOM ranges, preserving inline marks.
    const total = node.textContent?.length || 0
    if (!total) { node.style.maxHeight = `${PDF_CONTENT_HEIGHT}px`; node.style.maxWidth = '100%'; node.style.objectFit = 'contain'; body.append(node); return }
    let low = 1, high = total, cut = 0
    while (low <= high) {
      const mid = Math.floor((low + high) / 2), prefix = textSlice(node, 0, mid)
      if (fits(prefix)) { cut = mid; low = mid + 1 } else high = mid - 1
    }
    if (!cut) throw new Error('文档包含无法分页的内容，请简化该段格式后重试。')
    const text = node.textContent || '', boundary = text.slice(Math.max(0, cut - 80), cut).search(/[\s。；，.!?][^\s。；，.!?]*$/)
    if (boundary >= 0) cut = Math.max(0, cut - 80) + boundary + 1
    body.append(textSlice(node, 0, cut))
    if (cut < total) { newPage(); append(textSlice(node, cut, total)) }
  }
  for (const node of Array.from(article.children)) {
    const element = node as HTMLElement
    if (element.tagName === 'TABLE') {
      const head = element.querySelector('thead')
      const makeTable = () => { const table = element.cloneNode(false) as HTMLElement; if (head) table.append(head.cloneNode(true)); table.append(document.createElement('tbody')); return table }
      let table = makeTable()
      for (const row of element.querySelectorAll('tbody > tr')) {
        const copy = row.cloneNode(true) as HTMLElement
        table.lastElementChild!.append(copy)
        if (!fits(table) && table.lastElementChild!.childElementCount > 1) {
          copy.remove(); append(table); newPage(); table = makeTable(); table.lastElementChild!.append(copy)
        }
      }
      if (table.lastElementChild!.childElementCount) append(table)
    } else if (['UL', 'OL'].includes(element.tagName)) {
      Array.from(element.children).forEach((item, index) => { const list = element.cloneNode(false) as HTMLElement; if (element.tagName === 'OL') list.setAttribute('start', String(Number(element.getAttribute('start') || 1) + index)); list.append(item.cloneNode(true)); append(list) })
    } else if (element.tagName === 'NAV') {
      for (const child of Array.from(element.children)) append(child.cloneNode(true) as HTMLElement)
    } else append(element.cloneNode(true) as HTMLElement)
  }
  return pages
}
function textSlice(element: HTMLElement, start: number, end: number): HTMLElement {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let position = 0, first: Text | null = null, last: Text | null = null, firstOffset = 0, lastOffset = 0
  while (walker.nextNode()) {
    const text = walker.currentNode as Text, next = position + text.length
    if (!first && start < next) { first = text; firstOffset = Math.max(0, start - position) }
    if (first && end <= next) { last = text; lastOffset = end - position; break }
    position = next
  }
  const clone = element.cloneNode(false) as HTMLElement
  if (!first || !last) return clone
  const range = document.createRange(); range.setStart(first, firstOffset); range.setEnd(last, lastOffset)
  let fragment: Node = range.cloneContents()
  let ancestor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer as Element
  while (ancestor && ancestor !== element) { const wrapper = ancestor.cloneNode(false); wrapper.appendChild(fragment); fragment = wrapper; ancestor = ancestor.parentElement }
  clone.append(fragment)
  return clone
}
