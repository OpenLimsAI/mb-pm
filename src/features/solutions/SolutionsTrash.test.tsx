import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('report recycle bin', () => {
  it('confirms deletion and restores a report including its original contents after remount', async () => {
    const client = createDemoClient('test', 'author', '研究员')
    const original = (await client.list())[0]
    const view = render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
    fireEvent.click(await screen.findByRole('button', { name: `删除${original.title}` }))
    expect(screen.getByRole('dialog', { name: '删除研究报告' })).toHaveTextContent('可随时恢复')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(await client.list()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: `删除${original.title}` }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await screen.findByText('报告已移入回收站，可随时恢复。')
    expect(await client.list()).toHaveLength(0)
    view.unmount()
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
    fireEvent.click(await screen.findByRole('button', { name: '回收站' }))
    const dialog = await screen.findByRole('dialog', { name: '报告回收站' })
    expect(await within(dialog).findByText(original.title)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复' }))
    expect(await within(dialog).findByText('回收站暂无报告。')).toBeInTheDocument()
    expect((await client.list())[0].sections).toEqual(original.sections)
    expect(await client.trash()).toHaveLength(0)
  })

  it('keeps the report when deletion fails and shows the error in the dialog', async () => {
    const client = createDemoClient('test', 'author', '研究员')
    const original = (await client.list())[0]
    vi.spyOn(client, 'remove').mockRejectedValueOnce(new Error('服务器暂时不可用'))
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview initialHome />)
    fireEvent.click(await screen.findByRole('button', { name: `删除${original.title}` }))
    const dialog = screen.getByRole('dialog', { name: '删除研究报告' })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('服务器暂时不可用')
    expect(await client.list()).toHaveLength(1)
  })
})
