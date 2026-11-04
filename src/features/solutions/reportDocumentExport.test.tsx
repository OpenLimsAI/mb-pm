import html2canvas from 'html2canvas'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { paginateReport } from './reportPagination'
import { exportPdf, reportMarkdown } from './reportDocumentExport'
import { downloadBlob } from './api'
import { docxBlob } from './export'
import { readWordText } from './reportImportWord'
import { defaultExportOptions } from './reportExportOptions'
import type { Solution } from './types'

vi.mock('mammoth', async importOriginal => {
  const actual = await importOriginal<typeof import('mammoth')>()
  return { ...actual, convertToHtml: (input: { arrayBuffer: ArrayBuffer }, options: Parameters<typeof actual.convertToHtml>[1]) => actual.convertToHtml({ buffer: new Uint8Array(input.arrayBuffer) }, options) }
})
vi.mock('./api', () => ({ downloadBlob: vi.fn() }))
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'
vi.mock('html2canvas', () => ({ default: vi.fn(async () => ({ width: 794, height: 1123, toDataURL: () => png })) }))
const report = { id: 'r', title: '研究报告', ownerName: '张研究员', version: 1, projectName: '项目', sections: [{ id: 's', title: '证据', content: '**证据内容**\n\n| 条件 | 结果 |\n| --- | --- |\n| A | B |' }], references: [{ id: 'ref', title: '论文', sourceVersion: '1', locator: '第 2 页', excerpt: '研究原文' }] } as Solution
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); document.body.innerHTML = ''; document.getElementById('test-print-reset')?.remove() })
function geometry() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const height = Math.ceil((this.textContent?.length || 0) / 90) * 24
    return { x: 0, y: 0, left: 0, top: 0, width: 698, right: 698, height, bottom: height, toJSON: () => ({}) }
  })
}
describe('report document export', () => {
  it('exports headings, original Markdown and reference locators', () => {
    const markdown = reportMarkdown(report)
    expect(markdown).toContain('# 研究报告'); expect(markdown).toContain('## 证据'); expect(markdown).toContain('**证据内容**'); expect(markdown).toContain('第 2 页')
  })
  it('splits oversized marked paragraphs before canvas rendering without losing text or marks', () => {
    geometry()
    const article = document.createElement('article'); const paragraph = document.createElement('p'); const mark = document.createElement('strong'); mark.textContent = '实验条件与结果。'.repeat(1500); paragraph.append(mark); article.append(paragraph)
    const host = document.createElement('div'); document.body.append(host)
    const pages = paginateReport(article, host)
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.map(page => page.textContent).join('')).toBe(article.textContent)
    expect(pages.every(page => page.querySelector('strong'))).toBe(true)
  })
  it('round-trips editable Word headings, bold text and tables through the importer', async () => {
    const blob = docxBlob({ ...report, formula: [], status: 'draft' })
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob) })
    const markdown = await readWordText(buffer)
    expect(markdown).toContain('# 证据'); expect(markdown).toContain('**证据内容**'); expect(markdown).toContain('| **条件** | **结果** |')
  })
  it('writes a real cover break, A4 geometry, Word fields and one deduplicated bibliography entry', async () => {
    const blob = docxBlob({ ...report, formula: [], status: 'draft', references: [...report.references, { ...report.references[0], id: 'copy' }] }, { ...defaultExportOptions, organization: '企业&研究' })
    const buffer = await new Promise<ArrayBuffer>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob) })
    const bytes = new Uint8Array(buffer), view = new DataView(buffer), files = new Map<string, string>(); let offset = 0
    while (view.getUint32(offset, true) === 0x04034b50) {
      const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true)
      const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength)), start = offset + 30 + nameLength + extraLength
      files.set(name, new TextDecoder().decode(bytes.slice(start, start + length))); offset = start + length
    }
    for (const [name, value] of files) if (name.endsWith('.xml')) expect(new DOMParser().parseFromString(value, 'application/xml').querySelector('parsererror'), name).toBeNull()
    const document = files.get('word/document.xml')!
    expect(document).toContain('w:type="page"')
    expect(document).toContain('w:w="11906" w:h="16838"')
    expect(document).toContain('企业&amp;研究')
    expect(document.match(/\[1\] 论文/g)).toHaveLength(1)
    expect(files.get('word/footer1.xml')).toContain('NUMPAGES')
    expect(files.get('word/settings.xml')).toContain('updateFields')
  })
  it('keeps print hierarchy, list markers and paragraph spacing under an application CSS reset', async () => {
    const reset = document.createElement('style'); reset.id = 'test-print-reset'; reset.textContent = 'h1,h2,h3,p,ul,ol{font-size:inherit;font-weight:inherit;margin:0;padding:0}ol,ul{list-style:none}'; document.head.append(reset)
    let checked = false
    vi.mocked(html2canvas).mockImplementationOnce(async page => {
      const heading = getComputedStyle(page.querySelector('h1')!), subheading = getComputedStyle(page.querySelector('h2')!), paragraph = getComputedStyle(page.querySelector('p')!)
      expect(parseFloat(heading.fontSize)).toBeGreaterThan(parseFloat(subheading.fontSize))
      expect(parseFloat(subheading.fontSize)).toBeGreaterThan(parseFloat(paragraph.fontSize))
      expect(Number(heading.fontWeight)).toBeGreaterThan(400)
      expect(parseFloat(paragraph.marginBottom)).toBeGreaterThan(0)
      expect(getComputedStyle(page.querySelector('ol')!).listStyleType).toBe('decimal')
      expect(getComputedStyle(page.querySelector('ul')!).listStyleType).toBe('disc')
      checked = true
      return { width: 794, height: 1123, toDataURL: () => png } as HTMLCanvasElement
    })
    await exportPdf({ ...report, sections: [{ id: 's', title: '研究方法', content: '正文段落。\n\n1. 步骤一\n2. 步骤二\n\n- 条件甲\n- 条件乙\n\n> 来源引文。' }] }, { ...defaultExportOptions, cover: false })
    expect(checked).toBe(true)
  })
  it('creates actual PDF bytes with more than one page for a long Chinese report', async () => {
    geometry()
    await exportPdf({ ...report, sections: [{ id: 's', title: '长章节', content: '实验条件与结果。'.repeat(1500) }] })
    const blob = vi.mocked(downloadBlob).mock.calls[0][0]
    const raw = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob) })
    expect(raw.startsWith('%PDF-')).toBe(true)
    expect(raw).toMatch(/\/Count [3-9]/)
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('研究报告-v1.pdf')
  })
})
