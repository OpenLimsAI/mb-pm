import type { Solution } from './types'
import { downloadBlob } from './api'
import { statusLabels } from './template'
import { wordMarkdown, xmlText } from './wordPreviewMarkup'
import type { WordAsset } from './wordPreviewMarkup'
import { defaultExportOptions } from './reportExportOptions'
import type { ReportExportOptions } from './reportExportOptions'
import { normalizedReport, referenceEntry, reportCaptions, reportReferences, resolveCitations } from './reportReferences'

const enc = new TextEncoder()
const xml = xmlText
const paragraph = (s: string, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(s)}</w:t></w:r></w:p>`

// Small stored ZIP writer: preview exports the same editable OOXML format as the server.
export function docxBlob(input: Solution, options: ReportExportOptions = defaultExportOptions): Blob {
  const solution = normalizedReport(input), bibliography = reportReferences(solution)
  const assets: WordAsset[] = []
  const coverParagraph = (text: string, size: number, before: number) => `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="${before}" w:after="360"/></w:pPr><w:r><w:rPr><w:sz w:val="${size}"/><w:color w:val="24476B"/></w:rPr><w:t>${xml(text)}</w:t></w:r></w:p>`
  const content = options.cover ? [coverParagraph(options.organization || '研究报告', 24, 2600), coverParagraph(solution.title, 44, 900), coverParagraph(`v${solution.version} · ${statusLabels[solution.status]} · ${solution.ownerName}`, 22, 600), coverParagraph(`项目：${solution.projectName}  产品：${solution.productName}`, 22, 0), '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'] : [paragraph(solution.title, true)]
  content.push(`<w:p><w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h"><w:r><w:t>目录（在 Word 中更新域）${solution.sections.map(section => `</w:t><w:br/><w:t>${xml(section.title)}`).join('')}</w:t></w:r></w:fldSimple></w:p>`)
  if (options.figureIndex) { const captions = reportCaptions(solution); if (captions.length) content.push(paragraph('图表目录', true), ...captions.map(caption => paragraph(`${caption.kind === 'figure' ? '图' : '表'} ${caption.number} ${caption.title}`))) }
  for (const section of solution.sections) content.push(wordMarkdown(`# ${section.title}\n\n${resolveCitations(section.content, bibliography)}`, assets))
  if (solution.formula.length) content.push(paragraph('配方组成', true))
  for (const row of solution.formula) content.push(paragraph(`${row.material} | ${row.amount} ${row.unit} | ${row.basis} | ${row.rationale} | ${row.verification === 'pending' ? '待验证' : '已确认'}`))
  content.push(paragraph('参考资料', true))
  for (const item of bibliography) content.push(paragraph(referenceEntry(item, options.bibliography === 'detailed')))
  if (solution.reviewNotes) content.push(paragraph('评审说明', true), paragraph(solution.reviewNotes))
  const files: Record<string, string | Uint8Array<ArrayBuffer>> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content.join('')}<w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`,
  }
  files['word/_rels/document.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="header" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${assets.map(asset => `<Relationship Id="${asset.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${asset.path}"/>`).join('')}</Relationships>`
  files['word/styles.xml'] = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${options.template === 'compact' ? 280 : 360}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${[1, 2, 3].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - level * 4}"/></w:rPr></w:style>`).join('')}</w:styles>`
  files['word/header1.xml'] = `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph([options.organization, solution.title].filter(Boolean).join(' · '))}</w:hdr>`
  files['word/settings.xml'] = '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/></w:settings>'
  files['word/footer1.xml'] = '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr="PAGE"/><w:r><w:t> / </w:t></w:r><w:fldSimple w:instr="NUMPAGES"/></w:p></w:ftr>'
  for (const asset of assets) files[`word/${asset.path}`] = asset.bytes
  const chunks: Uint8Array<ArrayBuffer>[] = [], central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0, centralSize = 0
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name), data = typeof text === 'string' ? enc.encode(text) : text
    let crc = 0xffffffff
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = new Uint8Array(30 + n.length), lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true); local.set(n, 30)
    const directory = new Uint8Array(46 + n.length), cv = new DataView(directory.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true); directory.set(n, 46)
    chunks.push(local, data); central.push(directory); offset += local.length + data.length; centralSize += directory.length
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, central.length, true); view.setUint16(10, central.length, true); view.setUint32(12, centralSize, true); view.setUint32(16, offset, true)
  return new Blob([...chunks, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}
export function exportPreview(solution: Solution, options: ReportExportOptions = defaultExportOptions) { downloadBlob(docxBlob(solution, options), `${solution.title.replace(/[\\/:*?"<>|]/g, '-')}-v${solution.version}.docx`) }
