import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WBSTable } from './WBSTable'
import { projects } from '../../mock'
import { updateTaskProgress } from '../../data/bootstrap'

const name = '生产模式与工艺锁定（fed-batch/perfusion）与最终生产方案确认'
vi.mock('../../mock', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../mock')>()
  return {
    ...original,
    getProjectSubs: () => [{ ...original.subProjects[0], id: 's-column' }],
    getSubTasks: () => [{ ...original.tasks[0], id: 't-column', subProjectId: 's-column', name: '生产模式与工艺锁定（fed-batch/perfusion）与最终生产方案确认' }],
  }
})
vi.mock('../../data/bootstrap', () => ({ updateTaskProgress: vi.fn() }))

describe('WBS 名称列', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })
  it('调宽并记住名称列，悬浮全文和任务入口保留，调整不提交任务进展', () => {
    const open = vi.fn()
    const { container, unmount } = render(<WBSTable project={projects[0]} onOpenTask={open} />)
    const separator = screen.getByRole('separator', { name: '调整 WBS 任务列宽度' })
    const initial = Number(separator.getAttribute('aria-valuenow'))
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    const wider = Number(separator.getAttribute('aria-valuenow'))
    expect(wider).toBeGreaterThan(initial)
    expect(container.querySelector('col')).toHaveStyle({ width: `${wider}px` })
    const task = screen.getByRole('button', { name })
    expect(task).toHaveAttribute('title', expect.stringContaining(name))
    fireEvent.click(task)
    expect(open).toHaveBeenCalledWith('t-column')
    expect(updateTaskProgress).not.toHaveBeenCalled()
    unmount()
    render(<WBSTable project={projects[0]} />)
    expect(screen.getByRole('separator', { name: '调整 WBS 任务列宽度' })).toHaveAttribute('aria-valuenow', String(wider))
  })
})
