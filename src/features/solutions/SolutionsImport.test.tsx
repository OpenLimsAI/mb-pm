import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import type { Solution, SolutionClient } from './types'

const seed = (): Solution => ({ id: 'original', title: '原报告', projectName: '项目A', productName: '', ownerId: 'author', ownerName: '研究员', status: 'draft', revision: 1, version: 1, updatedAt: '2026-10-25T00:00:00Z', sections: [{ id: 's1', title: '原章节', content: '原正文' }], formula: [], references: [], reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true })
function clientMock() {
  const docs = new Map([['original', seed()]])
  const client: SolutionClient = {
    list: vi.fn(async () => [...docs.values()]), get: vi.fn(async id => structuredClone(docs.get(id)!)),
    create: vi.fn(async input => { const doc = { ...seed(), ...input, id: 'imported' }; docs.set(doc.id, doc); return structuredClone(doc) }),
    save: vi.fn(async (id, input) => { const doc = { ...docs.get(id)!, ...input, revision: input.revision + 1 }; docs.set(id, doc); return structuredClone(doc) }),
    sources: vi.fn(async () => []), reviewers: vi.fn(async () => []), history: vi.fn(async () => []),
    knowledgeStatus: vi.fn(async () => ({ configured: false, available: false, message: '' })),
    getSource: vi.fn(), addSource: vi.fn(), ask: vi.fn(), review: vi.fn(), versions: vi.fn(), exportWord: vi.fn(), publish: vi.fn(),
  }
  return { client, docs }
}
function upload(name = '新报告.md', text = '# 导入标题\n\n导入的正文。') {
  const file = new File([text], name)
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer })
  fireEvent.change(screen.getByLabelText('选择报告文件'), { target: { files: [file] } })
}
async function mount() {
  const mock = clientMock(), result = render(<SolutionsApp client={mock.client} userId="author" userName="研究员" preview />)
  await screen.findByRole('textbox', { name: '章节正文' })
  return { ...mock, ...result }
}
async function openImport() {
  fireEvent.click(screen.getByRole('button', { name: '导入' }))
  upload()
  await screen.findByRole('textbox', { name: '导入正文预览' })
  return screen.getByRole('dialog', { name: '导入报告' })
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('report import integration', () => {
  it('places import immediately before export and layout immediately before the workbench', async () => {
    const { container } = await mount()
    const header = container.querySelector('.ks-top-actions')!
    const actions = [...header.children].map(element => element.textContent)
    expect(actions.slice(-4)).toEqual(['导入', '导出', '排列布局', '应用工作台'])
    expect(within(header as HTMLElement).queryByRole('button', { name: '提交评审' })).not.toBeInTheDocument()
  })
  it('previews before creating, saves the current draft and imports as a separate report', async () => {
    const { client, docs } = await mount()
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '正在写的修改' } })
    const dialog = await openImport()
    expect(client.create).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('textbox', { name: '导入正文预览' })).toHaveValue('# 导入标题\n\n导入的正文。')
    fireEvent.change(within(dialog).getByRole('textbox', { name: '报告名称' }), { target: { value: '自定报告名' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入为新报告' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('# 导入标题\n\n导入的正文。'))
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(docs.get('original')!.sections[0].content).toBe('正在写的修改')
    expect(docs.get('original')!.title).toBe('原报告')
    expect(docs.get('imported')!.title).toBe('自定报告名')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('keeps the preview and original text if saving the current report fails', async () => {
    const { client } = await mount()
    vi.mocked(client.save).mockRejectedValue(new Error('版本冲突'))
    fireEvent.change(screen.getByRole('textbox', { name: '章节正文' }), { target: { value: '不能丢失的修改' } })
    const dialog = await openImport()
    fireEvent.click(within(dialog).getByRole('button', { name: '导入为新报告' }))
    await within(dialog).findByText(/当前报告尚未保存/)
    expect(client.create).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('textbox', { name: '导入正文预览' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('不能丢失的修改')
  })
  it('retains the parsed document after create fails so it can be retried', async () => {
    const { client } = await mount()
    vi.mocked(client.create).mockRejectedValueOnce(new Error('创建暂时失败'))
    const dialog = await openImport()
    fireEvent.click(within(dialog).getByRole('button', { name: '导入为新报告' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('创建暂时失败')
    expect(within(dialog).getByRole('textbox', { name: '报告名称' })).toHaveValue('新报告')
    fireEvent.click(within(dialog).getByRole('button', { name: '导入为新报告' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(client.create).toHaveBeenCalledTimes(2)
  })
  it('rejects unsupported formats and leaves the report untouched when cancelled', async () => {
    const { client } = await mount()
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    expect(screen.getByLabelText('选择报告文件')).toHaveAttribute('accept', '.docx,.pdf,.md,.markdown')
    upload('不支持.txt')
    expect(await screen.findByRole('alert')).toHaveTextContent('只支持')
    expect(screen.getByRole('button', { name: '导入为新报告' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('原正文')
    expect(client.create).not.toHaveBeenCalled()
  })
  it('prevents duplicate submissions and dismissal while creating the imported report', async () => {
    const { client, docs } = await mount()
    let complete!: () => void
    vi.mocked(client.create).mockImplementation(input => new Promise(resolve => { complete = () => { const value = { ...seed(), ...input, id: 'imported' }; docs.set(value.id, value); resolve(value) } }))
    const dialog = await openImport()
    const submit = within(dialog).getByRole('button', { name: '导入为新报告' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1))
    expect(within(dialog).getByRole('button', { name: '正在导入…' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))
    expect(dialog).toBeInTheDocument()
    // Closing a successful import does not depend on a second user action.
    await act(async () => complete())
    expect(screen.queryByRole('dialog', { name: '导入报告' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('# 导入标题\n\n导入的正文。')
  })
  it('ignores a late file read after cancelling the import window', async () => {
    const { client } = await mount()
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    let complete!: (buffer: ArrayBuffer) => void
    const file = new File(['正文'], '慢文档.md')
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { complete = resolve }) })
    fireEvent.change(screen.getByLabelText('选择报告文件'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await act(async () => complete(new TextEncoder().encode('正文').buffer))
    expect(screen.queryByRole('dialog', { name: '导入报告' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '章节正文' })).toHaveValue('原正文')
    expect(client.create).not.toHaveBeenCalled()
  })
})
