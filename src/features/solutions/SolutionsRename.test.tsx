import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'

beforeEach(() => { localStorage.clear(); localStorage.setItem('ks-editor-mode', 'markdown'); sessionStorage.clear() })

describe('rename a report from its list card', () => {
  it('saves the new name and preserves content through reopening', async () => {
    const client = createDemoClient('rename', 'author', '研究员')
    const original = (await client.list())[0]
    const view = render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
    fireEvent.click(await screen.findByRole('button', { name: `修改${original.title}名称` }))
    const dialog = screen.getByRole('dialog', { name: '修改报告名称' })
    const input = within(dialog).getByRole('textbox', { name: '报告名称' })
    fireEvent.change(input, { target: { value: '   ' } })
    expect(within(dialog).getByRole('button', { name: '保存名称' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '  稳定性研究报告  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存名称' }))
    expect(await screen.findByText('报告名称已更新。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '稳定性研究报告' })).toBeInTheDocument()
    const saved = (await client.list())[0]
    expect(saved.title).toBe('稳定性研究报告')
    expect(saved.sections).toEqual(original.sections)
    expect(saved.references).toEqual(original.references)
    view.unmount()
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
    expect(await screen.findByRole('button', { name: '稳定性研究报告' })).toBeInTheDocument()
  })

  it('keeps the original report and displays errors when saving fails', async () => {
    const client = createDemoClient('rename', 'author', '研究员')
    const original = (await client.list())[0]
    vi.spyOn(client, 'save').mockRejectedValueOnce(new Error('保存失败，请重试'))
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
    fireEvent.click(await screen.findByRole('button', { name: `修改${original.title}名称` }))
    const dialog = screen.getByRole('dialog', { name: '修改报告名称' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '报告名称' }), { target: { value: '新名称' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存名称' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('保存失败，请重试')
    expect((await client.list())[0].title).toBe(original.title)
  })

  it('refuses to overwrite a report changed in another tab', async () => {
    const client = createDemoClient('rename', 'author', '研究员')
    const original = (await client.list())[0]
    const save = vi.spyOn(client, 'save')
    vi.spyOn(client, 'get').mockResolvedValueOnce({ ...original, revision: original.revision + 1 })
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
    fireEvent.click(await screen.findByRole('button', { name: `修改${original.title}名称` }))
    const dialog = screen.getByRole('dialog', { name: '修改报告名称' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '报告名称' }), { target: { value: '新名称' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存名称' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('报告已在其他页面更新')
    expect(save).not.toHaveBeenCalled()
    expect((await client.list())[0].title).toBe(original.title)
  })

  it('does not offer a reviewer an author rename action', async () => {
    const client = createDemoClient('rename', 'author', '研究员')
    const original = (await client.list())[0]
    render(<SolutionsApp client={client} userId="reviewer" userName="评审者" preview initialHome />)
    await screen.findByRole('button', { name: original.title })
    expect(screen.queryByRole('button', { name: `修改${original.title}名称` })).not.toBeInTheDocument()
  })
})
