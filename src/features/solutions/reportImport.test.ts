import { describe, expect, it } from 'vitest'
import { parseReportFile, reportFileKind, reportFromText, REPORT_IMPORT_MAX_BYTES } from './reportImport'

function textFile(name: string, text: string) {
  const buffer = new TextEncoder().encode(text).buffer
  return { name, size: buffer.byteLength, arrayBuffer: async () => buffer } as File
}

describe('report file import', () => {
  it.each(['x.docx', 'x.DOCX', 'x.pdf', 'x.md', 'x.markdown'])('accepts only the documented formats: %s', name => {
    expect(() => reportFileKind(name)).not.toThrow()
  })
  it.each(['x.docm', 'x.docx.exe', 'x.txt', 'x.html', 'x.csv'])('rejects other formats: %s', name => {
    expect(() => reportFileKind(name)).toThrow('只支持')
  })
  it('explains how to import legacy Word documents', () => { expect(() => reportFileKind('x.doc')).toThrow('另存为 .docx') })
  it('reads UTF-8 Markdown, retains markup and creates fresh section ids without evidence or formula', async () => {
    const first = await parseReportFile(textFile('研究报告.md', '\uFEFF# 研究报告\r\n\r\n**证据**与[来源](https://example.org)'))
    const second = await parseReportFile(textFile('研究报告.md', '# 内容'))
    expect(first.input).toMatchObject({ title: '研究报告', projectName: '', productName: '', formula: [], references: [], sections: [{ title: '导入正文', content: '# 研究报告\n\n**证据**与[来源](https://example.org)' }] })
    expect(first.input.sections[0].id).not.toBe(second.input.sections[0].id)
  })
  it('preserves every character when splitting long text, including paragraph boundaries and emoji', () => {
    for (const text of ['a'.repeat(50_000) + '\n\n后文', 'a'.repeat(49_999) + '😀' + 'b'.repeat(60_000)]) {
      const parsed = reportFromText('长报告.md', text, 'markdown')
      expect(parsed.input.sections.every(section => section.content.length <= 50_000)).toBe(true)
      expect(parsed.input.sections.map(section => section.content).join('')).toBe(text)
    }
  })
  it('rejects oversized, empty, binary and invalid UTF-8 files', async () => {
    await expect(parseReportFile({ ...textFile('x.md', 'x'), size: REPORT_IMPORT_MAX_BYTES + 1 } as File)).rejects.toThrow('20 MB')
    await expect(parseReportFile(textFile('x.md', ''))).rejects.toThrow('为空')
    await expect(parseReportFile(textFile('x.md', 'a\u0000b'))).rejects.toThrow('无法读取')
    await expect(parseReportFile({ name: 'x.md', size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer } as File)).rejects.toThrow('UTF-8')
    expect(() => reportFromText('x.md', 'x'.repeat(200_001), 'markdown')).toThrow('20 万字')
  })
  it('explains empty PDF text and never reports a scan as imported', () => {
    expect(() => reportFromText('scan.pdf', '\n\n', 'pdf')).toThrow('OCR')
  })
  it('does not finish a cancelled read', async () => {
    const abort = new AbortController()
    const file = textFile('x.md', '正文')
    file.arrayBuffer = async () => { abort.abort(); return new TextEncoder().encode('正文').buffer }
    await expect(parseReportFile(file, abort.signal)).rejects.toThrow()
  })
})
