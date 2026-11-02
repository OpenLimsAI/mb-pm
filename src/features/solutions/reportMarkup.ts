import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

export const MAX_REPORT_IMAGE_BYTES = 1024 * 1024
export function safeReportImage(src: string): boolean {
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length <= Math.ceil(MAX_REPORT_IMAGE_BYTES * 4 / 3) + 50
}
/** HTML from Word/paste is parsed offscreen; only portable document formatting survives. */
export function htmlToReportMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button,svg,math').forEach(node => node.remove())
  doc.querySelectorAll('*').forEach(node => {
    for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name) || ['style', 'srcset'].includes(attribute.name)) node.removeAttribute(attribute.name)
    if (node instanceof HTMLAnchorElement && !/^(https?:|mailto:|#)/i.test(node.getAttribute('href') || '')) node.removeAttribute('href')
    if (node instanceof HTMLImageElement && !safeReportImage(node.getAttribute('src') || '')) node.replaceWith(doc.createTextNode(`[图片：${node.alt || '外部或不支持的图片'}]`))
  })
  // GFM needs a header row. Word commonly exports every cell as td.
  doc.querySelectorAll('table').forEach(table => {
    const row = table.querySelector('tr')
    if (row && !row.querySelector('th')) for (const cell of [...row.children]) { const header = doc.createElement('th'); header.innerHTML = cell.innerHTML; cell.replaceWith(header) }
  })
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  converter.use(gfm)
  converter.addRule('reportTableCell', { filter: ['th', 'td'], replacement: (content, node) => `${node.previousElementSibling ? ' ' : '| '}${content.trim().replace(/\n+/g, '<br>').replaceAll('|', '\\|')} |` })
  return converter.turndown(doc.body.innerHTML)
}

export async function readReportImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_REPORT_IMAGE_BYTES) throw new Error('请选择不超过 1 MB 的 PNG、JPEG 或 WebP 图片。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  if (!(file.type === 'image/png' ? png : file.type === 'image/jpeg' ? jpeg : webp)) throw new Error('图片内容与文件格式不符。')
  if (file.type === 'image/webp') {
    const bitmap = await createImageBitmap(file)
    try {
      if (bitmap.width * bitmap.height > 16_000_000) throw new Error('图片尺寸过大，请压缩到 1600 万像素以内。')
      const canvas = document.createElement('canvas'), scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const result = canvas.toDataURL('image/png')
      if (!safeReportImage(result)) throw new Error('WebP 转换后超过 1 MB，请压缩图片后重试。')
      return result
    } finally { bitmap.close() }
  }
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file) })
}

export function stripReportImages(text: string): string { return text.replace(/!\[[^\]]*\]\(data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+\)/g, '[图片]') }
