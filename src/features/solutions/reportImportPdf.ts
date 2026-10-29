import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl
const pdfAssets = import.meta.glob<string>(['/node_modules/pdfjs-dist/cmaps/*.bcmap', '/node_modules/pdfjs-dist/standard_fonts/*.pfb', '/node_modules/pdfjs-dist/standard_fonts/*.ttf'], { query: '?url', import: 'default', eager: true })
class LocalPdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const directory = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : ''
    const url = pdfAssets[`/node_modules/pdfjs-dist/${directory}/${filename}`]
    if (!url) throw new Error('PDF text resource unavailable')
    const response = await fetch(url)
    if (!response.ok) throw new Error('PDF text resource could not be loaded')
    return new Uint8Array(await response.arrayBuffer())
  }
}

export async function readPdfText(buffer: ArrayBuffer, signal?: AbortSignal): Promise<string> {
  const header = new TextDecoder().decode(buffer.slice(0, 1024))
  if (!header.includes('%PDF-')) throw new Error('Invalid PDF header')
  const task = getDocument({ data: new Uint8Array(buffer), BinaryDataFactory: LocalPdfData, isEvalSupported: false, useWorkerFetch: false, stopAtErrors: true })
  const cancel = () => { void task.destroy() }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const pdf = await task.promise
    if (pdf.numPages > 500) throw new Error('导入：PDF 超过 500 页，请拆分后导入。')
    let text = ''
    for (let i = 1; i <= pdf.numPages; i++) {
      signal?.throwIfAborted()
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      text += content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n\n'
      page.cleanup()
      if (text.length > 200_000) throw new Error('导入：正文超过 20 万字，请拆分文件后导入。')
    }
    return text
  } finally {
    signal?.removeEventListener('abort', cancel)
    await task.destroy()
  }
}
