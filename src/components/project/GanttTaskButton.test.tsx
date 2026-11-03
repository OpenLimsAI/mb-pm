import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '../../types'
import { GanttTaskButton } from './GanttTaskButton'

const task: Task = {
  id: 'task-1', subProjectId: 'sub-1', code: 'CMAB-PRJ-2026-0002-OTH-001',
  name: '供应商考察、选定及质量体系文件的联合评审', ownerId: 'owner-1',
  plannedStart: '2026-11-01', plannedEnd: '2026-12-15',
  status: '进行中', priority: '中', progress: 35, estimatedEffort: 5,
  isMilestone: false, isCriticalPath: false,
}

describe('甘特任务条', () => {
  it('宽条默认显示完整任务名称，提示保留编号、负责人、日期和进度', () => {
    render(<GanttTaskButton task={task} ownerName="郭清城" style={{ left: 80, top: 34, width: 160 }}>
      <span data-testid="progress" aria-hidden="true" />
    </GanttTaskButton>)
    const button = screen.getByRole('button', { name: new RegExp(task.name) })
    expect(within(button).getByText(task.name)).toBeVisible()
    expect(within(button).queryByText(task.code)).not.toBeInTheDocument()
    expect(within(button).getByTestId('progress')).toBeInTheDocument()
    for (const value of [task.name, task.code, '郭清城', task.plannedStart, task.plannedEnd, '进行中', '35%']) {
      expect(button.getAttribute('title')).toContain(value)
      expect(button.getAttribute('aria-label')).toContain(value)
    }
    expect(button.style.left).toBe('80px')
    expect(button.style.top).toBe('34px')
    expect(button.style.width).toBe('160px')
    expect(button).toHaveAttribute('type', 'button')
  })

  it('键盘 Enter 可打开任务详情，未分配时提供明确负责人提示', async () => {
    const user = userEvent.setup()
    const onSelectTask = vi.fn()
    render(<GanttTaskButton task={task} ownerName=" " onSelectTask={onSelectTask} style={{ width: 100 }} />)
    const button = screen.getByRole('button', { name: /负责人：未分配/ })
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSelectTask).toHaveBeenCalledExactlyOnceWith(task.id)
  })

  it.each([
    { label: '短任务条', isMilestone: false, width: 20 },
    { label: '里程碑', isMilestone: true, width: 18 },
  ])('$label 保留完整说明，可聚焦和点击，文字不挤入图形', async ({ isMilestone, width }) => {
    const user = userEvent.setup()
    const onSelectTask = vi.fn()
    render(<GanttTaskButton task={{ ...task, isMilestone }} onSelectTask={onSelectTask} style={{ width }} compact />)
    const button = screen.getByRole('button', { name: new RegExp(task.name) })
    expect(within(button).queryByText(task.name)).not.toBeInTheDocument()
    expect(button.getAttribute('title')).toContain(task.code)
    await user.tab()
    expect(button).toHaveFocus()
    await user.click(button)
    expect(onSelectTask).toHaveBeenCalledExactlyOnceWith(task.id)
  })
})
