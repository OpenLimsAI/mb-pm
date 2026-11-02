import type { SolutionInput } from './types'

export const REPORT_IMPORT_ACCEPT = '.docx,.pdf,.md,.markdown'
export const REPORT_IMPORT_MAX_BYTES = 20 * 1024 * 1024
const MAX_TEXT = 200_000
const MAX_SECTION = 50_000
const IMAGE_PATTERN = /!\[[^\]]*\]\(data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+\)/g
export type ReportFileKind = 'word' | 'pdf' | 'markdown'
export interface ImportedReport { fileName: string; kind: ReportFileKind; characters: number; input: SolutionInput }

export function reportFileKind(name: string): ReportFileKind {
  if (/\.docx$/i.test(name)) return 'word'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.(md|markdown)$/i.test(name)) return 'markdown'
  if (/\.doc$/i.test(name)) throw new Error('请先将旧版 Word（.doc）另存为 .docx 后再导入。')
  throw new Error('只支持 Word（.docx）、PDF（.pdf）和 Markdown（.md、.markdown）文件。')
}

export function reportFromText(fileName: string, text: string, kind: ReportFileKind): ImportedReport {
  const content = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  if (!content) throw new Error(kind === 'pdf' ? '未读取到 PDF 正文。扫描版 PDF 请先进行文字识别（OCR）后再导入。' : '文件中没有可导入的正文。')
  if (content.length > 12_000_000) throw new Error('文档含图片后的总容量超过 12 MB，请压缩图片后导入。')
  if (content.replace(IMAGE_PATTERN, '[图片]').length > MAX_TEXT) throw new Error('正文超过 20 万字，请拆分文件后导入。')
  if ([...content].some(char => char.charCodeAt(0) < 32 && char !== '\n' && char !== '\t')) throw new Error('文件包含无法读取的内容，请检查文件格式或另存为 UTF-8 Markdown。')
  const sections: SolutionInput['sections'] = []
  let fenced = false
  const blocks: { title: string; level: number; lines: string[] }[] = []
  let block = { title: '导入正文', level: 0, lines: [] as string[] }
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = !fenced && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading && blocks.length < 58) {
      if (block.lines.join('\n').trim() || block.title !== '导入正文') blocks.push(block)
      block = { title: heading[2].slice(0, 200), level: heading[1].length, lines: [] }
    } else block.lines.push(line)
  }
  if (block.lines.join('\n').trim() || !blocks.length || block.title !== '导入正文') blocks.push(block)
  const parents: { level: number; id: string }[] = []
  for (const item of blocks) {
    while (parents.length && parents.at(-1)!.level >= item.level) parents.pop()
    const parentId = parents.at(-1)?.id || null
    let firstId = ''
    let remaining = item.lines.join('\n').trim(), continuation = 0
    do {
      let end = Math.min(MAX_SECTION, remaining.length)
      const image = [...remaining.matchAll(IMAGE_PATTERN)].find(match => match.index! < end && match.index! + match[0].length > end)
      if (image) end = image.index! === 0 ? image[0].length : image.index!
      else if (end < remaining.length) {
        const paragraph = remaining.lastIndexOf('\n\n', end - 2)
        if (paragraph > MAX_SECTION / 2) end = paragraph + 2
        else if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1
      }
      const id = crypto.randomUUID(); if (!firstId) firstId = id
      sections.push({ id, ...(parentId ? { parentId } : {}), title: continuation ? `${item.title}（续 ${continuation}）` : item.title, content: remaining.slice(0, end) })
      remaining = remaining.slice(end); continuation++
      if (sections.length > 60) throw new Error('识别出超过 60 个章节，请拆分文档后导入。')
    } while (remaining)
    if (item.level) parents.push({ level: item.level, id: firstId })
  }
  const title = fileName.replace(/\.(docx|pdf|md|markdown)$/i, '').trim().slice(0, 200) || '导入的研究报告'
  return { fileName, kind, characters: content.length, input: { title, projectName: '', productName: '', sections, formula: [], references: [] } }
}

export async function parseReportFile(file: File, signal?: AbortSignal): Promise<ImportedReport> {
  const kind = reportFileKind(file.name)
  if (file.size > REPORT_IMPORT_MAX_BYTES) throw new Error('文件超过 20 MB，请压缩或拆分后导入。')
  if (!file.size) throw new Error('文件为空，请重新选择。')
  signal?.throwIfAborted()
  const buffer = await file.arrayBuffer()
  signal?.throwIfAborted()
  let text: string
  try {
    if (kind === 'markdown') text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    else if (kind === 'word') {
      const { readWordText } = await import('./reportImportWord')
      signal?.throwIfAborted()
      text = await readWordText(buffer)
    } else {
      const { readPdfText } = await import('./reportImportPdf')
      signal?.throwIfAborted()
      text = await readPdfText(buffer, signal)
    }
  } catch (reason) {
    signal?.throwIfAborted()
    if (kind === 'markdown') throw new Error('Markdown 编码无法读取，请将文件另存为 UTF-8 后重试。', { cause: reason })
    if (reason instanceof Error && reason.message.startsWith('导入：')) throw new Error(reason.message.slice(3), { cause: reason })
    throw new Error(kind === 'word' ? 'Word 文件无法读取，请检查文件是否完整，并另存为 .docx 后重试。' : 'PDF 文件无法读取，请检查是否损坏或受密码保护。', { cause: reason })
  }
  signal?.throwIfAborted()
  return reportFromText(file.name, text, kind)
}
