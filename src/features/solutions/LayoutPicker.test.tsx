import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LayoutPicker from './LayoutPicker'
import { defaultWorkspaceLayout } from './layout'
import type { WorkspaceLayout } from './layout'

function mount(value: WorkspaceLayout = { ...defaultWorkspaceLayout, order: [...defaultWorkspaceLayout.order] }) {
  const onApply = vi.fn(), onClose = vi.fn()
  render(<LayoutPicker value={value} onApply={onApply} onClose={onClose} />)
  return { value, onApply, onClose }
}

afterEach(() => vi.restoreAllMocks())

describe('workspace layout picker', () => {
  it('shows the current arrangement and numbers each module using the supplied order', () => {
    mount({ arrangement: 'right-main', order: ['knowledge', 'ai', 'editor'] })
    expect(screen.getByRole('button', { name: '左上下右一' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '横向三个' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '知识库资料' })).toHaveAccessibleDescription('位置 1 · 左上')
    expect(screen.getByRole('button', { name: 'AI 研究助手' })).toHaveAccessibleDescription('位置 2 · 左下')
    expect(screen.getByRole('button', { name: '报告撰写' })).toHaveAccessibleDescription('位置 3 · 右侧')
    expect(screen.getByRole('button', { name: '应用排列' })).toBeEnabled()
  })

  it('stages layout and order changes, requires all three choices, and applies only the complete selection', () => {
    const { value, onApply, onClose } = mount()
    const original = structuredClone(value)
    fireEvent.click(screen.getByRole('button', { name: '上二下一' }))
    fireEvent.click(screen.getByRole('button', { name: '重置顺序' }))
    expect(screen.getByRole('button', { name: '应用排列' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('已选 0 / 3 个模块')
    fireEvent.click(screen.getByRole('button', { name: 'AI 研究助手' }))
    fireEvent.click(screen.getByRole('button', { name: '报告撰写' }))
    expect(screen.getByRole('button', { name: '应用排列' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '报告撰写' })).toHaveAccessibleDescription('位置 2 · 右上')
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '知识库资料' }))
    fireEvent.click(screen.getByRole('button', { name: '应用排列' }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ arrangement: 'top-pair', order: ['ai', 'editor', 'knowledge'] })
    expect(onClose).not.toHaveBeenCalled()
    expect(value).toEqual(original)
  })

  it('renumbers the remaining modules compactly after a selected module is removed', () => {
    const { onApply } = mount()
    fireEvent.click(screen.getByRole('button', { name: '报告撰写' }))
    expect(screen.getByRole('button', { name: '报告撰写' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '知识库资料' })).toHaveAccessibleDescription('位置 1 · 左侧')
    expect(screen.getByRole('button', { name: 'AI 研究助手' })).toHaveAccessibleDescription('位置 2 · 右上')
    expect(screen.getByRole('button', { name: '应用排列' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '报告撰写' }))
    fireEvent.click(screen.getByRole('button', { name: '应用排列' }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ arrangement: 'left-main', order: ['knowledge', 'ai', 'editor'] })
  })

  it('cancels without mutating the supplied layout or writing persistent storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { value, onApply, onClose } = mount()
    const original = structuredClone(value)
    fireEvent.click(screen.getByRole('button', { name: '横向三个' }))
    fireEvent.click(screen.getByRole('button', { name: '重置顺序' }))
    fireEvent.click(screen.getByRole('button', { name: 'AI 研究助手' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(value).toEqual(original)
  })

  it('supports selecting the arrangement and assigning all modules using a keyboard', async () => {
    mount()
    const user = userEvent.setup()
    await user.tab()
    expect(screen.getByRole('button', { name: '横向三个' })).toHaveFocus()
    await user.keyboard(' ')
    expect(screen.getByRole('button', { name: '横向三个' })).toHaveAttribute('aria-pressed', 'true')
    await user.tab(); await user.tab(); await user.tab(); await user.tab()
    expect(screen.getByRole('button', { name: '重置顺序' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.tab(); await user.keyboard(' ')
    await user.tab(); await user.keyboard('{Enter}')
    await user.tab(); await user.keyboard(' ')
    expect(screen.getByRole('button', { name: '报告撰写' })).toHaveAccessibleDescription('位置 1 · 左侧')
    expect(screen.getByRole('button', { name: '知识库资料' })).toHaveAccessibleDescription('位置 2 · 中间')
    expect(screen.getByRole('button', { name: 'AI 研究助手' })).toHaveAccessibleDescription('位置 3 · 右侧')
    expect(screen.getByRole('button', { name: '应用排列' })).toBeEnabled()
  })
})
