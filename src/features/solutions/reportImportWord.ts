// Check the DOCX container before expanding it. ZIP64 and oversized archives are
// intentionally rejected; imported reports only need the document's plain text.
function checkContainer(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  let end = -1
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('Invalid DOCX archive')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true), total = 0
  if (count > 2000) throw new Error('导入：Word 文件内容过多，请拆分后重试。')
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid DOCX entry')
    total += view.getUint32(offset + 24, true)
    if (total > 32 * 1024 * 1024) throw new Error('导入：Word 解压后内容超过 32 MB，请拆分后重试。')
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
}

export async function readWordText(buffer: ArrayBuffer): Promise<string> {
  checkContainer(buffer)
  const mammoth = await import('mammoth')
  // Never insert converted HTML, embedded images or document links into the DOM.
  const result = await mammoth.extractRawText({ arrayBuffer: buffer })
  return result.value
}
