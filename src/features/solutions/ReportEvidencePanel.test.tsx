import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReportEvidencePanel from './ReportEvidencePanel'
import ReportExportMenu from './ReportExportMenu'
import ReportMarkdown from './ReportMarkdown'
import { citationToken, reportReferences } from './reportReferences'
import { reportPrintMarkup } from './reportDocumentExport'
import type { Solution } from './types'
const report = { projectName: '', productName: '', ownerId: 'owner', revision: 1, updatedAt: '', reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true, id: 'r', title: '报告', sections: [{ id: 's', title: '方法', content: '当前结论。' }], references: [{ id: 'ref', sourceId: 'paper', sourceVersion: 'v1', sectionId: 's', title: '论文', excerpt: '来源原文', locator: '第2页' }], formula: [], status: 'draft', ownerName: '用户', version: 1 } as Solution
describe('report evidence and export review', () => {
  it('binds a selected conclusion while retaining the original source excerpt', () => {
    const update = vi.fn(), insert = vi.fn()
    render(<ReportEvidencePanel solution={report} selectedText="当前结论" onChangeReferences={update} onInsertCitation={insert} onOpenSource={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /\[1\] 论文/ }))
    fireEvent.click(screen.getByRole('button', { name: '绑定选中文字' }))
    expect(update).toHaveBeenCalledWith([expect.objectContaining({ excerpt: '来源原文', anchorText: '当前结论', sourceId: 'paper' })])
    fireEvent.change(screen.getByRole('textbox', { name: '适用条件 论文' }), { target: { value: '仅用于该研究对象' } })
    expect(update).toHaveBeenLastCalledWith([expect.objectContaining({ excerpt: '来源原文', applicability: '仅用于该研究对象' })])
    fireEvent.click(screen.getByRole('button', { name: '插入引用' }))
    expect(insert).toHaveBeenCalledWith(report.references[0])
  })
  it('opens the exact source from a rendered citation number', () => {
    const open = vi.fn()
    render(<ReportMarkdown references={reportReferences(report)} onReference={open}>{`当前结论${citationToken('ref')}`}</ReportMarkdown>)
    fireEvent.click(screen.getByRole('button', { name: '[1]' }))
    expect(open).toHaveBeenCalledWith(report.references[0])
  })
  it('prepares a saved report before preview and safely renders organization and captions', async () => {
    const prepare = vi.fn(async () => ({ ...report, title: '已保存的报告' }))
    render(<ReportExportMenu solution={report} onPrepare={prepare} />)
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    fireEvent.click(screen.getByRole('button', { name: '排版设置与导出预览' }))
    const preview = await screen.findByRole('dialog', { name: '报告导出预览' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(preview).toHaveTextContent('已保存的报告')
    fireEvent.change(screen.getByRole('textbox', { name: '导出机构名称' }), { target: { value: '<img src=x onerror=alert(1)>' } })
    expect(preview.querySelector('img')).toBeNull()
    const markup = reportPrintMarkup({ ...report, sections: [{ ...report.sections[0], content: '[图 9　条件](#report-figure-f)\n\n参见[图 9](#report-figure-f)。' }] })
    expect(markup).toContain('图表目录')
    expect(markup).toContain('图 1')
    expect(markup).not.toContain('图 9')
  })
})
