import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ReportCollaborationPanel from './ReportCollaborationPanel'
import ReportNoteLinks from './ReportNoteLinks'
import { reportNoteReferences } from './reportNoteReferences'
import VersionHistoryPanel from './VersionHistoryPanel'
import { createDemoClient } from './demo'
import { createPreviewNotesClient } from '../notes/client'
import type { Version } from './types'

beforeEach(() => localStorage.clear())
describe('report collaboration and private linked notes', () => {
  it('persists anchored comment replies and resolution without incrementing the document revision', async () => {
    const client = createDemoClient('collaboration', 'author', '研究员'), doc = (await client.list())[0]
    render(<ReportCollaborationPanel doc={doc} client={client} currentSectionId={doc.sections[0].id} selectedText="研究目标" onNavigate={vi.fn()} />)
    await screen.findByText('研究员 · 作者')
    fireEvent.change(screen.getByRole('textbox', { name: '批注内容' }), { target: { value: '请核对实验条件' } })
    fireEvent.click(screen.getByRole('button', { name: '添加批注' }))
    await screen.findByText('请核对实验条件')
    fireEvent.click(screen.getByRole('button', { name: /^回复$/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '批注内容' }), { target: { value: '已补充适用条件' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回复' }))
    await screen.findByText('已补充适用条件')
    fireEvent.click(screen.getByRole('button', { name: '标记已解决' }))
    await waitFor(() => expect(screen.queryByText('请核对实验条件')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已解决' }))
    await screen.findByText('请核对实验条件')
    expect((await client.collaboration!(doc.id)).comments).toHaveLength(2)
    expect((await client.get(doc.id)).revision).toBe(doc.revision)
  })
  it('compares a linked note update and requires explicit adoption into the report', async () => {
    const client = createDemoClient('note-link', 'author', '研究员'), notes = createPreviewNotesClient('note-link:author')
    const note = await notes.create('n1', { title: '实验思考', content: '原笔记正文', sourceApp: 'manual', sourceTitle: '', sourceUrl: '' })
    const doc = (await client.list())[0], sectionId = doc.sections[0].id
    doc.sections[0].content = `原笔记正文\n\n[笔记来源：实验思考](/notes?note=n1)`
    Object.assign(doc, await client.save(doc.id, { ...doc, revision: doc.revision }))
    const replace = vi.fn(async (target: string, before: string, after: string) => { const current = await client.get(doc.id); await client.save(doc.id, { ...current, sections: current.sections.map(section => section.id === target ? { ...section, content: section.content.replace(before, after) } : section), revision: current.revision }); return true })
    const view = render(<ReportNoteLinks doc={doc} client={client} notesClient={notes} onReplace={replace} />)
    await screen.findByText('与笔记版本一致')
    await notes.save(note, { ...note, content: '更新后的笔记正文' })
    view.rerender(<ReportNoteLinks doc={{ ...doc, revision: doc.revision + 1 }} client={client} notesClient={notes} onReplace={replace} />)
    await screen.findByText('笔记有更新')
    expect(replace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看差异' }))
    fireEvent.click(screen.getByRole('button', { name: '确认更新报告中的笔记内容' }))
    expect(replace).toHaveBeenCalledWith(sectionId, '原笔记正文', '更新后的笔记正文')
    await waitFor(async () => expect((await client.noteLinks!(doc.id))[0].noteRevision).toBe(2))
  })
  it('does not advance the note snapshot when saving the report fails', async () => {
    const client = createDemoClient('note-conflict', 'author', '研究员'), notes = createPreviewNotesClient('note-conflict:author')
    const note = await notes.create('n1', { title: '笔记', content: '原文 A', sourceApp: 'manual', sourceTitle: '', sourceUrl: '' })
    const doc = (await client.list())[0], sectionId = doc.sections[0].id
    doc.sections[0].content = '原文 A\n\n[笔记](/notes?note=n1)'
    Object.assign(doc, await client.save(doc.id, { ...doc, revision: doc.revision }))
    await client.linkNote!(doc.id, note.id, sectionId, note.revision)
    await notes.save(note, { ...note, content: '新文 B' })
    let finish!: (value: boolean) => void
    const replace = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })), link = vi.spyOn(client, 'linkNote')
    render(<ReportNoteLinks doc={doc} client={client} notesClient={notes} onReplace={replace} />)
    await screen.findByText('笔记有更新'); fireEvent.click(screen.getByText('查看差异')); fireEvent.click(screen.getByText('确认更新报告中的笔记内容'))
    expect(link).not.toHaveBeenCalled()
    await act(async () => finish(false))
    expect(await screen.findByRole('alert')).toHaveTextContent('原笔记内容已在报告中修改')
    expect(link).not.toHaveBeenCalled()
    expect((await client.noteLinks!(doc.id))[0].noteRevision).toBe(1)
    expect((await client.get(doc.id)).sections[0].content).toContain('原文 A')
    replace.mockRejectedValueOnce(new Error('报告尚未成功保存，笔记关联版本未更新。'))
    fireEvent.click(screen.getByText('确认更新报告中的笔记内容'))
    expect(await screen.findByRole('alert')).toHaveTextContent('报告尚未成功保存')
    expect(link).not.toHaveBeenCalled()
    expect((await client.noteLinks!(doc.id))[0].noteRevision).toBe(1)
  })
  it('waits for an initial report save before binding the note baseline', async () => {
    const client = createDemoClient('note-initial-save', 'author', '研究员'), notes = createPreviewNotesClient('note-initial-save:author')
    await notes.create('n1', { title: '笔记', content: '原文 A', sourceApp: 'manual', sourceTitle: '', sourceUrl: '' })
    const doc = (await client.list())[0]; doc.sections[0].content = '原文 A\n\n[笔记](/notes?note=n1)'
    const link = vi.spyOn(client, 'linkNote'), replace = vi.fn(() => true)
    const view = render(<ReportNoteLinks doc={doc} reportSaved={false} client={client} notesClient={notes} onReplace={replace} />)
    await screen.findByText(/笔记来源尚未关联/)
    expect(link).not.toHaveBeenCalled()
    expect(screen.queryByText('与笔记版本一致')).not.toBeInTheDocument()
    const saved = await client.save(doc.id, { ...doc, revision: doc.revision })
    view.rerender(<ReportNoteLinks doc={saved} reportSaved client={client} notesClient={notes} onReplace={replace} />)
    await screen.findByText('与笔记版本一致')
    expect(link).toHaveBeenCalledWith(doc.id, 'n1', doc.sections[0].id, 1)
  })
  it('retains the old note snapshot when the note changes after comparison', async () => {
    const client = createDemoClient('note-race', 'author', '研究员'), notes = createPreviewNotesClient('note-race:author')
    const note = await notes.create('n1', { title: '笔记', content: '原文 A', sourceApp: 'manual', sourceTitle: '', sourceUrl: '' })
    const doc = (await client.list())[0], sectionId = doc.sections[0].id
    doc.sections[0].content = '原文 A\n\n[笔记](/notes?note=n1)'; Object.assign(doc, await client.save(doc.id, { ...doc, revision: doc.revision }))
    await client.linkNote!(doc.id, note.id, sectionId, 1)
    const b = await notes.save(note, { ...note, content: '新文 B' })
    const replace = vi.fn(async () => { const current = await client.get(doc.id); await client.save(doc.id, { ...current, sections: current.sections.map(section => ({ ...section, content: section.content.replace('原文 A', '新文 B') })), revision: current.revision }); await notes.save(b, { ...b, content: '新文 C' }); return true })
    render(<ReportNoteLinks doc={doc} client={client} notesClient={notes} onReplace={replace} />)
    await screen.findByText('笔记有更新'); fireEvent.click(screen.getByText('查看差异')); fireEvent.click(screen.getByText('确认更新报告中的笔记内容'))
    expect(await screen.findByRole('alert')).toHaveTextContent('笔记已在其他页面更新')
    expect((await client.noteLinks!(doc.id))[0]).toMatchObject({ noteRevision: 1, content: '原文 A' })
    expect((await client.get(doc.id)).sections[0].content).toContain('新文 B')
  })
  it('can finish recording a note baseline after its text was saved by a previous interrupted attempt', async () => {
    const client = createDemoClient('note-retry-lineage', 'author', '研究员'), notes = createPreviewNotesClient('note-retry-lineage:author')
    const note = await notes.create('n1', { title: '笔记', content: '原文 A', sourceApp: 'manual', sourceTitle: '', sourceUrl: '' })
    const doc = (await client.list())[0], sectionId = doc.sections[0].id
    doc.sections[0].content = '原文 A\n\n[笔记](/notes?note=n1)'; Object.assign(doc, await client.save(doc.id, { ...doc, revision: doc.revision }))
    await client.linkNote!(doc.id, note.id, sectionId, 1)
    await notes.save(note, { ...note, content: '新文 B' })
    const saved = await client.save(doc.id, { ...doc, sections: doc.sections.map(section => ({ ...section, content: section.content.replace('原文 A', '新文 B') })), revision: doc.revision })
    const replace = vi.fn(() => false)
    render(<ReportNoteLinks doc={saved} client={client} notesClient={notes} onReplace={replace} />)
    await screen.findByText('笔记有更新'); fireEvent.click(screen.getByText('查看差异')); fireEvent.click(screen.getByText('确认更新报告中的笔记内容'))
    await screen.findByText('与笔记版本一致')
    expect(replace).not.toHaveBeenCalled()
    expect((await client.noteLinks!(doc.id))[0].noteRevision).toBe(2)
  })
  it('ignores malformed note links and never treats an external URL as a personal note', async () => {
    const client = createDemoClient('note-parse', 'author', '研究员'), doc = (await client.list())[0]
    doc.sections[0].content = '[x](https://other.test/notes?note=a) [x](/notes?note=%ZZ) [x](/notes?note=n1)'
    expect(reportNoteReferences(doc)).toEqual([{ noteId: 'n1', sectionId: doc.sections[0].id }])
  })
  it('confirms the exact before and after paragraphs for a partial historical restore', async () => {
    const client = createDemoClient('partial-history', 'author', '研究员'), doc = (await client.list())[0]
    doc.sections = [{ id: 'g', title: '研究目标', content: '当前第一段\n\n当前第二段' }]
    const version = { id: 'v1', version: 1, note: '初稿', actorName: '作者', createdAt: new Date().toISOString(), snapshot: { ...doc, sections: [{ id: 'g', title: '研究目标', content: '历史第一段\n\n历史第二段' }] } } as Version
    const restore = vi.fn().mockResolvedValue(undefined)
    render(<VersionHistoryPanel doc={doc} versions={[version]} busy={false} onSnapshot={vi.fn()} onRestoreSection={vi.fn()} onRestoreReport={vi.fn()} onRestoreParagraph={restore} />)
    fireEvent.click(screen.getByRole('button', { name: '选择第 2 段' }))
    expect(restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认恢复此段落' }))
    expect(restore).toHaveBeenCalledWith('g', '当前第二段', '历史第二段')
  })
})
