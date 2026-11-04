import type { CSSProperties } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Solution } from './types'
import { downloadBlob } from './api'
import { safeReportImage } from './reportMarkup'
import { paginateReport } from './reportPagination'
import { normalizedReport, referenceEntry, reportCaptions, reportReferences, resolveCitations } from './reportReferences'
import { defaultExportOptions } from './reportExportOptions'
import type { ReportExportOptions } from './reportExportOptions'

const printHeading = (size: number): CSSProperties => ({ fontSize: size, fontWeight: 700, lineHeight: 1.35, margin: '22px 0 12px', color: '#24476b', breakAfter: 'avoid' })
const printParagraph: CSSProperties = { fontSize: 14, lineHeight: 1.8, margin: '0 0 14px' }
const printList = (ordered: boolean): CSSProperties => ({ fontSize: 14, lineHeight: 1.8, listStyleType: ordered ? 'decimal' : 'disc', listStylePosition: 'outside', paddingLeft: 26, margin: '8px 0 14px' })
const fileName = (solution: Solution, extension: string) => `${solution.title.replace(/[\\/:*?"<>|]/g, '-')}-v${solution.version}.${extension}`
export function reportMarkdown(input: Solution, options: ReportExportOptions = defaultExportOptions): string {
  const solution = normalizedReport(input), bibliography = reportReferences(solution)
  const sections = solution.sections.map(section => `## ${section.title}\n\n${resolveCitations(section.content, bibliography)}`)
  const refs = bibliography.map(item => referenceEntry(item, options.bibliography === 'detailed'))
  return `# ${solution.title}\n\n${solution.projectName ? `项目：${solution.projectName}\n\n` : ''}${sections.join('\n\n')}\n\n## 参考文献\n\n${refs.join('\n\n')}\n`
}
export function exportMarkdown(solution: Solution, options: ReportExportOptions = defaultExportOptions) { downloadBlob(new Blob([reportMarkdown(solution, options)], { type: 'text/markdown;charset=utf-8' }), fileName(solution, 'md')) }
export function reportPrintMarkup(solution: Solution, options: ReportExportOptions = defaultExportOptions): string {
  const captions = reportCaptions(normalizedReport(solution)), compact = options.template === 'compact'
  return renderToStaticMarkup(<article style={{ fontFamily: 'Arial,"PingFang SC","Microsoft YaHei",sans-serif' }}>
    {options.cover && <section data-report-cover="true" style={{ minHeight: 980, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}><p style={{ ...printParagraph, color: '#637b8d' }}>{options.organization || '研究报告'}</p><h1 style={{ ...printHeading(30), marginTop: 0 }}>{solution.title}</h1><p style={{ ...printParagraph, color: '#637b8d', paddingBottom: 16, borderBottom: '2px solid #c4d6e4' }}>{solution.ownerName} · v{solution.version}{solution.productName ? ` · ${solution.productName}` : ''}</p><p style={printParagraph}>{solution.projectName}</p></section>}
    {!options.cover && <h1 style={printHeading(26)}>{solution.title}</h1>}
    <nav><h2 style={printHeading(20)}>目录</h2><ol style={printList(true)}>{solution.sections.map(section => <li key={section.id} style={{ display: 'list-item', paddingLeft: 4, marginBottom: 6 }}>{section.title}</li>)}</ol></nav>
    {options.figureIndex && captions.length > 0 && <nav><h2 style={printHeading(20)}>图表目录</h2>{captions.map((caption, index) => <p key={index} style={printParagraph}>{caption.kind === 'figure' ? '图' : '表'} {caption.number}{'　'}{caption.title}</p>)}</nav>}
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => safeReportImage(url) || /^https?:/i.test(url) ? url : ''} components={{ h1: ({ children }) => <h1 style={printHeading(26)}>{children}</h1>, h2: ({ children }) => <h2 style={printHeading(22)}>{children}</h2>, h3: ({ children }) => <h3 style={printHeading(18)}>{children}</h3>, h4: ({ children }) => <h4 style={printHeading(16)}>{children}</h4>, h5: ({ children }) => <h5 style={printHeading(15)}>{children}</h5>, h6: ({ children }) => <h6 style={printHeading(14)}>{children}</h6>, p: ({ children }) => <p style={{ ...printParagraph, lineHeight: compact ? 1.55 : 1.8 }}>{children}</p>, ol: ({ children, start }) => <ol start={start} style={printList(true)}>{children}</ol>, ul: ({ children }) => <ul style={printList(false)}>{children}</ul>, li: ({ children }) => <li style={{ display: 'list-item', paddingLeft: 4, marginBottom: 6 }}>{children}</li>, strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>, em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>, blockquote: ({ children }) => <blockquote style={{ margin: '12px 0 18px', padding: '10px 16px', borderLeftWidth: 3, borderLeftStyle: 'solid', borderLeftColor: '#94b6c9', background: '#f3f7fa', color: '#496475' }}>{children}</blockquote>, pre: ({ children }) => <pre style={{ whiteSpace: 'pre-wrap', padding: 12, margin: '12px 0', background: '#eff3f6', fontFamily: 'monospace', fontSize: 12 }}>{children}</pre>, hr: () => <hr style={{ border: 0, borderTop: '1px solid #c4d6e4', margin: '18px 0' }} />, img: ({ src, alt }) => safeReportImage(src || '') ? <img src={src} alt={alt} style={{ maxWidth: '100%', maxHeight: 700 }} /> : <span>[图片：{alt || '外部图片'}]</span>, table: ({ children }) => <table style={{ borderCollapse: 'collapse', width: '100%', margin: '12px 0 18px', fontSize: 13, lineHeight: 1.65 }}>{children}</table>, td: ({ children }) => <td style={{ border: '1px solid #b9cbd7', padding: 8 }}>{children}</td>, th: ({ children }) => <th style={{ border: '1px solid #b9cbd7', padding: 8, background: '#eaf2f7' }}>{children}</th> }}>{reportMarkdown(solution, options).replace(/^# [^\n]+\n+/, '')}</ReactMarkdown>
  </article>)
}

/** Rasterized page text uses the browser's Chinese fonts rather than jsPDF's Latin-only defaults. */
export async function exportPdf(solution: Solution, options: ReportExportOptions = defaultExportOptions): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:0;top:0;z-index:-10000;width:794px;padding:48px;box-sizing:border-box;background:white;color:#243746;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.7;'
  host.innerHTML = reportPrintMarkup(solution, options)
  document.body.append(host)
  try {
    await document.fonts?.ready
    await Promise.all([...host.querySelectorAll('img')].map(img => img.decode().catch(() => undefined)))
    const article = host.firstElementChild as HTMLElement
    const pagesHost = document.createElement('div'); host.append(pagesHost)
    const pages = paginateReport(article, pagesHost)
    article.remove()
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
    for (let page = 0; page < pages.length; page++) {
      if (page) pdf.addPage()
      const header = document.createElement('div'); header.textContent = [options.organization, solution.title].filter(Boolean).join(' · '); header.style.cssText = 'position:absolute;top:14px;left:48px;right:48px;font-size:10px;color:#637b8d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'; pages[page].style.position = 'relative'; pages[page].append(header)
      const canvas = await html2canvas(pages[page], { scale: 1.5, width: 794, height: 1123, backgroundColor: '#ffffff', logging: false, useCORS: false, allowTaint: false })
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297)
      pdf.setFontSize(9); pdf.setTextColor(100); pdf.text(`${page + 1} / ${pages.length}`, 105, 292, { align: 'center' })
      canvas.width = 0; canvas.height = 0
    }
    downloadBlob(pdf.output('blob'), fileName(solution, 'pdf'))
  } finally { host.remove() }
}
