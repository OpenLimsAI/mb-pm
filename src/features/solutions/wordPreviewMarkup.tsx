import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { safeReportImage } from './reportMarkup'
export const xmlText = (s: string) => [...s].filter(char => char.charCodeAt(0) >= 32 || [9, 10, 13].includes(char.charCodeAt(0))).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export interface WordAsset { id: string; path: string; bytes: Uint8Array<ArrayBuffer> }
export function wordMarkdown(content: string, assets: WordAsset[]): string {
  const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === 'src' ? safeReportImage(url) ? url : '' : defaultUrlTransform(url)} components={{ img: ({ src, alt }) => safeReportImage(src || '') ? <img src={src} alt={alt} /> : <span>[图片：{alt || '外部图片未加载'}]</span> }}>{content}</ReactMarkdown>)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  function inline(node: Node, bold = false, italic = false): string {
    if (node.nodeType === Node.TEXT_NODE) return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}</w:rPr><w:t xml:space="preserve">${xmlText(node.textContent || '')}</w:t></w:r>`
    if (!(node instanceof Element)) return ''
    if (node.tagName === 'BR') return '<w:r><w:br/></w:r>'
    if (node.tagName === 'IMG') {
      const source = node.getAttribute('src') || ''
      if (!safeReportImage(source)) return inline(doc.createTextNode(`[图片：${node.getAttribute('alt') || '外部图片'}]`))
      const data = Uint8Array.from(atob(source.split(',')[1]), value => value.charCodeAt(0)), png = source.startsWith('data:image/png')
      const asset = { id: `image${assets.length + 1}`, path: `media/image${assets.length + 1}.${png ? 'png' : 'jpeg'}`, bytes: data }; assets.push(asset)
      let ratio = .6
      if (png && data.length >= 24) { const view = new DataView(data.buffer); ratio = view.getUint32(20) / Math.max(1, view.getUint32(16)) }
      const width = Math.round(Math.min(500, 700 / ratio) * 9525), height = Math.round(Math.min(700, 500 * ratio) * 9525)
      return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${assets.length}" name="${asset.id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${assets.length}" name="${asset.id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${asset.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    }
    return [...node.childNodes].map(child => inline(child, bold || ['STRONG', 'B'].includes(node.tagName), italic || ['EM', 'I'].includes(node.tagName))).join('')
  }
  function block(element: Element): string {
    const tag = element.tagName
    if (tag === 'TABLE') return `<w:tbl><w:tblPr><w:tblBorders>${['top', 'bottom', 'left', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="BCCDD9"/>`).join('')}</w:tblBorders></w:tblPr>${[...element.querySelectorAll('tr')].map(row => `<w:tr>${[...row.children].map(cell => `<w:tc><w:p>${inline(cell, cell.tagName === 'TH')}</w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
    if (['UL', 'OL'].includes(tag)) return [...element.children].map((item, index) => `<w:p>${inline(doc.createTextNode(tag === 'OL' ? `${index + 1}. ` : '• '))}${inline(item)}</w:p>`).join('')
    if (tag === 'BLOCKQUOTE') return [...element.children].map(child => `<w:p><w:pPr><w:ind w:left="480"/></w:pPr>${inline(child)}</w:p>`).join('')
    const level = /^H([1-6])$/.exec(tag)?.[1]
    return `<w:p>${level ? `<w:pPr><w:pStyle w:val="Heading${Math.min(3, Number(level))}"/></w:pPr>` : ''}${inline(element)}</w:p>`
  }
  return [...doc.body.children].map(block).join('')
}
