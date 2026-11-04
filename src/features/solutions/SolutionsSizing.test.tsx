import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import { createDemoClient } from './demo'
import { defaultWorkspaceLayout } from './layout'
import { getSizedGrid, readWorkspaceSizes, WORKSPACE_SIZES_KEY } from './workspaceSizing'

const savedSizes = {
  desktop: { 'left-main:111': { columns: [7, 3], rows: [3, 7] } },
  mobile: { editor: 720, knowledge: 480, ai: 540 },
}
const allVisible = { editor: true, knowledge: true, ai: true }

beforeEach(() => {
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('ks-writing-mode', 'split')
  localStorage.setItem(WORKSPACE_SIZES_KEY, JSON.stringify(savedSizes))
})
afterEach(() => vi.useRealTimers())

describe('workspace sizing integration', () => {
  it('restores saved module dimensions through hiding and focus mode without saving or remounting report inputs', async () => {
    const normalizedSizes = readWorkspaceSizes()
    const client = createDemoClient('workspace-sizing', 'author', '研究员')
    const save = vi.spyOn(client, 'save')
    render(<SolutionsApp client={client} userId="author" userName="研究员" preview />)
    const body = await screen.findByRole('textbox', { name: '章节正文' })
    const grid = screen.getByRole('region', { name: '报告工作区' })
    const knowledge = grid.querySelector<HTMLElement>('[data-module="knowledge"]')!
    const frame = knowledge.querySelector('iframe')
    const expected = { ...getSizedGrid(defaultWorkspaceLayout, allVisible, savedSizes) }
    expect(grid).toHaveStyle(expected)
    expect(knowledge.style.getPropertyValue('--ks-mobile-height')).toBe('480px')

    fireEvent.click(screen.getByRole('button', { name: '隐藏AI 研究助手' }))
    fireEvent.click(screen.getByRole('button', { name: '展开AI 研究助手' }))
    expect(grid).toHaveStyle(expected)
    fireEvent.click(screen.getByRole('switch', { name: '专注模式' }))
    expect(grid.querySelector('.ks-workspace-resizer')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: '专注模式' }))
    expect(grid).toHaveStyle(expected)
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBe(body)
    expect(knowledge.querySelector('iframe')).toBe(frame)

    vi.useFakeTimers()
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(save).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(WORKSPACE_SIZES_KEY)!)).toEqual(normalizedSizes)
    expect(sessionStorage.getItem('ks-draft:preview:author:demo-solution')).toBeNull()
  })
})
