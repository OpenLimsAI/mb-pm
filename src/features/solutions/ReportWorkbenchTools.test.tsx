import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReportWorkbenchTools from './ReportWorkbenchTools'
import type { Answer, Solution, SolutionClient } from './types'
const doc = { id: 'current', title: '当前报告', status: 'draft', canEdit: true, sections: [{ id: 's1', title: '目的', content: '' }], references: [] } as unknown as Solution
function setup(extra: Partial<SolutionClient> = {}) {
  const client = { list: vi.fn().mockResolvedValue([]), sources: vi.fn().mockResolvedValue([]), ask: vi.fn().mockResolvedValue({ content: '# 目标\n# 方法', references: [], mode: 'ai' }), ...extra } as unknown as SolutionClient
  const callbacks = { onClose: vi.fn(), onNavigate: vi.fn(), onInsert: vi.fn(), onAppendSections: vi.fn() }
  render(<ReportWorkbenchTools doc={doc} client={client} {...callbacks} />)
  return { client, ...callbacks }
}
describe('report workbench tools', () => {
  it('locates the unfinished chapter from a concrete quality issue', () => {
    const { onNavigate, onClose } = setup()
    fireEvent.click(screen.getByText('定位到章节'))
    expect(onNavigate).toHaveBeenCalledWith('s1')
    expect(onClose).toHaveBeenCalled()
  })
  it('inserts history through explicit confirmation callback with citations', async () => {
    const ref = { id: 'ref', sectionId: 'old' }
    const { onInsert } = setup({ list: vi.fn().mockResolvedValue([{ ...doc, id: 'other', title: '历史实验', version: 2, sections: [{ id: 'old', title: '方法', content: '稳定性验证观察' }], references: [ref] }]) })
    fireEvent.click(screen.getByText('复用历史报告'))
    fireEvent.change(screen.getByPlaceholderText('例如：稳定性 验证'), { target: { value: '稳定性' } })
    fireEvent.click(await screen.findByText('插入并保留来源…'))
    expect(onInsert).toHaveBeenCalledWith(expect.stringContaining('/solutions?report=other'), [ref], 's1')
  })
  it('requires confirmation after generating an outline before adding sections', async () => {
    const { client, onAppendSections } = setup()
    fireEvent.click(screen.getByText('资料到报告'))
    fireEvent.click(screen.getByText('下一步：明确问题'))
    fireEvent.change(screen.getByLabelText('希望回答的研究问题'), { target: { value: '比较两种方法' } })
    fireEvent.click(screen.getByText('生成研究大纲'))
    await waitFor(() => expect(client.ask).toHaveBeenCalledWith('current', expect.objectContaining({ answerMode: 'general', sourceIds: [] }), expect.any(AbortSignal)))
    expect(onAppendSections).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByText('确认并添加 2 个章节'))
    expect(onAppendSections).toHaveBeenCalledWith([expect.objectContaining({ title: '目标', content: expect.stringContaining('比较两种方法') }), expect.objectContaining({ title: '方法' })])
  })
  it('keeps generation locked while a background source request finishes and uses the current model', async () => {
    let finishSources!: (value: []) => void, finishAnswer!: (value: unknown) => void
    const client = { sources: vi.fn(() => new Promise(resolve => { finishSources = resolve })), ask: vi.fn(() => new Promise(resolve => { finishAnswer = resolve })) } as unknown as SolutionClient
    render(<ReportWorkbenchTools doc={doc} client={client} modelProfileId="selected-model" onClose={() => {}} onNavigate={() => {}} onInsert={() => {}} onAppendSections={() => {}} />)
    fireEvent.click(screen.getByText('资料到报告'))
    await waitFor(() => expect(client.sources).toHaveBeenCalled())
    fireEvent.click(screen.getByText('下一步：明确问题'))
    fireEvent.change(screen.getByLabelText('希望回答的研究问题'), { target: { value: '比较方法' } })
    fireEvent.click(screen.getByText('生成研究大纲'))
    await act(async () => finishSources([]))
    expect(screen.getByRole('button', { name: '生成研究大纲' })).toBeDisabled()
    expect(client.ask).toHaveBeenCalledWith('current', expect.objectContaining({ modelProfileId: 'selected-model' }), expect.any(AbortSignal))
    await act(async () => finishAnswer({ mode: 'ai', content: '# 研究计划', references: [] }))
    expect(await screen.findByText('确认并添加 1 个章节')).toBeVisible()
  })
  it('aborts an outline request when changing tabs and ignores the late result', async () => {
    let finish!: (value: unknown) => void
    const { client } = setup({ ask: vi.fn<SolutionClient['ask']>(() => new Promise(resolve => { finish = value => resolve(value as Answer) })) })
    fireEvent.click(screen.getByText('资料到报告'))
    fireEvent.click(screen.getByText('下一步：明确问题'))
    fireEvent.change(screen.getByLabelText('希望回答的研究问题'), { target: { value: '问题' } })
    fireEvent.click(screen.getByText('生成研究大纲'))
    const signal = vi.mocked(client.ask).mock.calls[0][2]!
    fireEvent.click(screen.getByText('质量检查'))
    expect(signal.aborted).toBe(true)
    await act(async () => finish({ mode: 'ai', content: '# 迟到大纲', references: [] }))
    fireEvent.click(screen.getByText('资料到报告'))
    expect(screen.queryByText(/确认并添加/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('希望回答的研究问题')).toHaveValue('问题')
  })
  it('clearly identifies a retrieval fallback and requires explicit template confirmation', async () => {
    const { onAppendSections } = setup({ ask: vi.fn().mockResolvedValue({ mode: 'retrieval', content: '# 原文段落标题', references: [] }) })
    fireEvent.click(screen.getByText('资料到报告'))
    fireEvent.click(screen.getByText('下一步：明确问题'))
    fireEvent.change(screen.getByLabelText('希望回答的研究问题'), { target: { value: '问题' } })
    fireEvent.click(screen.getByText('生成研究大纲'))
    expect(await screen.findByText(/本次返回资料检索摘录，未生成 AI 大纲/)).toBeVisible()
    expect(screen.getByLabelText('确认大纲 · 每行一个章节')).not.toHaveValue(expect.stringContaining('原文段落标题'))
    expect(onAppendSections).not.toHaveBeenCalled()
  })
  it('aborts pending work on unmount and disables generation for a read-only report', async () => {
    const ask = vi.fn<SolutionClient['ask']>(() => new Promise(() => {})), client = { sources: vi.fn().mockResolvedValue([]), ask } as unknown as SolutionClient
    const callbacks = { onClose: vi.fn(), onNavigate: vi.fn(), onInsert: vi.fn(), onAppendSections: vi.fn() }
    const view = render(<ReportWorkbenchTools doc={doc} client={client} {...callbacks} />)
    fireEvent.click(screen.getByText('资料到报告'))
    fireEvent.click(screen.getByText('下一步：明确问题'))
    fireEvent.change(screen.getByLabelText('希望回答的研究问题'), { target: { value: '问题' } })
    fireEvent.click(screen.getByText('生成研究大纲'))
    const signal = ask.mock.calls[0][2] as AbortSignal
    view.unmount(); expect(signal.aborted).toBe(true)
    render(<ReportWorkbenchTools doc={{ ...doc, canEdit: false }} client={client} {...callbacks} />)
    fireEvent.click(screen.getByText('资料到报告')); fireEvent.click(screen.getByText('下一步：明确问题'))
    fireEvent.change(screen.getByLabelText('希望回答的研究问题'), { target: { value: '问题' } })
    expect(screen.getByRole('button', { name: '生成研究大纲' })).toBeDisabled()
  })

})
