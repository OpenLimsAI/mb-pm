import type { Solution } from './types'
import { downloadBlob } from './api'
import { statusLabels } from './template'
import { wordMarkdown } from './wordPreviewMarkup'
import type { WordAsset } from './wordPreviewMarkup'

const enc = new TextEncoder()
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const paragraph = (s: string, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(s)}</w:t></w:r></w:p>`

// Small stored ZIP writer: preview exports the same editable OOXML format as the server.
export function docxBlob(solution: Solution): Blob {
  const assets: WordAsset[] = []
  const content = [paragraph(solution.title, true), paragraph(`v${solution.version} · ${statusLabels[solution.status]} · ${solution.ownerName}`), paragraph(`项目：${solution.projectName}  产品：${solution.productName}`)]
  content.push('<w:p><w:fldSimple w:instr="TOC \\o &quot;1-3&quot; \\h"><w:r><w:t>目录（在 Word 中更新域）</w:t></w:r></w:fldSimple></w:p>')
  for (const section of solution.sections) content.push(wordMarkdown(`# ${section.title}\n\n${section.content}`, assets))
  if (solution.formula.length) content.push(paragraph('配方组成', true))
  for (const row of solution.formula) content.push(paragraph(`${row.material} | ${row.amount} ${row.unit} | ${row.basis} | ${row.rationale} | ${row.verification === 'pending' ? '待验证' : '已确认'}`))
  content.push(paragraph('参考资料', true))
  for (const reference of solution.references) content.push(paragraph(`${reference.title} · ${reference.sourceVersion} · ${reference.locator}`), paragraph(reference.excerpt))
  if (solution.reviewNotes) content.push(paragraph('评审说明', true), paragraph(solution.reviewNotes))
  const files: Record<string, string | Uint8Array<ArrayBuffer>> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content.join('')}<w:sectPr><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`,
  }
  files['word/_rels/document.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="footer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${assets.map(asset => `<Relationship Id="${asset.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${asset.path}"/>`).join('')}</Relationships>`
  files['word/styles.xml'] = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${[1, 2, 3].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - level * 4}"/></w:rPr></w:style>`).join('')}</w:styles>`
  files['word/footer1.xml'] = '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr="PAGE"/></w:p></w:ftr>'
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
export function exportPreview(solution: Solution) { downloadBlob(docxBlob(solution), `${solution.title.replace(/[\\/:*?"<>|]/g, '-')}-v${solution.version}.docx`) }
