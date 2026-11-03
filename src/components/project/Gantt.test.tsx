import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Gantt } from './Gantt'
import type { Project } from '../../types'
import { useDataStore } from '../../store/data'

const fixture = vi.hoisted(() => ({
  project: { id: 'p1', code: 'PRJ-1', name: '测试项目' },
  sub: { id: 's1', projectId: 'p1', name: '子项目', sortOrder: 1 },
  tasks: [
    { id: 't1', subProjectId: 's1', code: 'T1', name: '长任务', plannedStart: '2026-01-01', plannedEnd: '2026-12-31', isMilestone: false, status: '进行中', progress: 40, estimatedEffort: 30 },
    { id: 't2', subProjectId: 's1', code: 'T2', name: '验收节点', plannedStart: '2027-04-01', plannedEnd: '2027-04-01', isMilestone: true, status: '未开始', progress: 0, estimatedEffort: 0 },
    { id: 't3', subProjectId: 's1', code: 'T3', name: '短任务', plannedStart: '2026-06-01', plannedEnd: '2026-06-01', isMilestone: false, status: '未开始', progress: 0, estimatedEffort: 1 },
  ],
}))
vi.mock('../../mock', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../mock')>(),
  getProjectSubs: () => [fixture.sub], getSubTasks: () => fixture.tasks,
  findUser: () => undefined, TODAY: new Date(2026, 5, 15),
  taskDependencies: [{ id: 'd1', predecessorId: 't1', successorId: 't2', type: 'FS' }],
}))
vi.mock('../../lib/cpm', () => ({ computeCPM: () => ({ criticalPathIds: new Set(), byId: new Map(fixture.tasks.map((t) => [t.id, t])) }) }))

describe('项目甘特图时间缩放', () => {
  it('调宽名称列后保留任务全文提示，并按新可视宽度缩放时间轴', () => {
    const select = vi.fn()
    const view = render(<Gantt project={fixture.project as Project} onSelectTask={select} />)
    try {
      const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
      Object.defineProperty(timeline, 'clientWidth', { configurable: true, value: 820 })
      const divider = screen.getByRole('separator', { name: '调整任务名称列宽' })
      const labels = timeline.querySelector('.gantt-label-column') as HTMLElement
      expect(within(labels).getByText('长任务')).toHaveAttribute('title', '长任务')
      expect(within(labels).getByText('子项目')).toHaveAttribute('title', '子项目')
      fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true })
      expect(timeline.style.getPropertyValue('--gantt-label-width')).toBe('368px')
      expect(select).not.toHaveBeenCalled()
      timeline.scrollLeft = 800
      fireEvent.change(screen.getByRole('slider', { name: '时间轴缩放' }), { target: { value: '33' } })
      const halfVisible = (820 - 368) / 2
      expect(timeline.scrollLeft).toBeCloseTo((800 + halfVisible) / 8 * 3 - halfVisible)
      fireEvent.doubleClick(divider)
      expect(timeline.style.getPropertyValue('--gantt-label-width')).toBe('320px')
    } finally {
      view.unmount()
      localStorage.removeItem('pm-column:project-gantt')
    }
  })

  it('连续缩放时间轴、任务、里程碑与依赖线，并保持视图中心', () => {
    render(<Gantt project={fixture.project as Project} />)
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    // The shared scroll region includes the 320px pinned task column.
    Object.defineProperty(timeline, 'clientWidth', { configurable: true, value: 820 })
    timeline.scrollLeft = 800
    const canvas = timeline.querySelector('.gantt-canvas') as HTMLElement
    const task = within(timeline).getByRole('button', { name: /长任务/ })
    const milestone = within(timeline).getByRole('button', { name: /验收节点/ })
    const dependency = timeline.querySelector('svg > path[marker-end]') as SVGPathElement
    const slider = screen.getByRole('slider', { name: '时间轴缩放' })
    const initialWidth = parseFloat(canvas.style.width)
    const taskWidth = parseFloat(task.style.width)
    const milestoneX = parseFloat(milestone.style.left) + 9
    const initialPath = dependency.getAttribute('d')!
    fireEvent.change(slider, { target: { value: '33' } })
    expect(parseFloat(canvas.style.width)).toBeCloseTo(initialWidth * 3 / 8)
    expect(parseFloat(task.style.width)).toBeCloseTo(taskWidth * 3 / 8)
    expect(parseFloat(milestone.style.left) + 9).toBeCloseTo(milestoneX * 3 / 8)
    expect(dependency.getAttribute('d')).not.toBe(initialPath)
    expect(timeline.scrollLeft).toBeCloseTo((800 + 250) / 8 * 3 - 250)
    fireEvent.change(slider, { target: { value: '45' } })
    const intermediateWidth = parseFloat(canvas.style.width)
    fireEvent.change(slider, { target: { value: '46' } })
    expect(parseFloat(canvas.style.width)).toBeGreaterThan(intermediateWidth)
    fireEvent.change(slider, { target: { value: '0' } })
    expect(within(timeline).getByText('2026')).toBeInTheDocument()
    expect(within(timeline).getAllByText('Q1').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '缩小时间轴' })).toBeDisabled()
    expect(timeline.scrollLeft).toBe(0)
    fireEvent.change(slider, { target: { value: '100' } })
    expect(screen.getByRole('button', { name: '放大时间轴' })).toBeDisabled()
    expect(slider).toHaveAttribute('aria-valuetext', '日视图，缩放位置 100 / 100')
  })

  it('在任务条显示名称，并让短任务和里程碑都能打开对应任务', () => {
    const select = vi.fn()
    render(<Gantt project={fixture.project as Project} onSelectTask={select} />)
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    const task = within(timeline).getByRole('button', { name: /长任务/ })
    expect(task).toHaveTextContent('长任务')
    expect(task).not.toHaveTextContent('T1')
    expect(task).toHaveAttribute('title', expect.stringContaining('任务编号：T1'))
    expect(task).toHaveAttribute('title', expect.stringContaining('负责人：未分配'))
    expect(task).toHaveAttribute('title', expect.stringContaining('计划结束：2026-12-31'))

    fireEvent.click(task)
    fireEvent.click(within(timeline).getByRole('button', { name: /短任务/ }))
    fireEvent.click(within(timeline).getByRole('button', { name: /验收节点/ }))
    expect(select.mock.calls).toEqual([['t1'], ['t3'], ['t2']])
  })

  it('从时间轴末端缩小时把水平位置限制在可滚动范围内', () => {
    render(<Gantt project={fixture.project as Project} />)
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    Object.defineProperty(timeline, 'clientWidth', { configurable: true, value: 820 })
    const canvas = timeline.querySelector('.gantt-canvas') as HTMLElement
    timeline.scrollLeft = parseFloat(canvas.style.width) - 500

    fireEvent.change(screen.getByRole('slider', { name: '时间轴缩放' }), { target: { value: '33' } })
    expect(timeline.scrollLeft).toBeCloseTo(Math.max(0, parseFloat(canvas.style.width) - 500))
  })

  it('收起子项目时同时移除任务条与关联依赖线，展开后恢复', () => {
    render(<Gantt project={fixture.project as Project} />)
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    expect(timeline.querySelector('svg > path[marker-end]')).not.toBeNull()
    fireEvent.click(within(timeline).getByRole('button', { name: /子项目/ }))
    expect(within(timeline).queryByRole('button', { name: /长任务/ })).not.toBeInTheDocument()
    expect(within(timeline).queryByRole('button', { name: /验收节点/ })).not.toBeInTheDocument()
    expect(timeline.querySelector('svg > path[marker-end]')).toBeNull()
    fireEvent.click(within(timeline).getByRole('button', { name: /子项目/ }))
    expect(within(timeline).getByRole('button', { name: /长任务/ })).toBeInTheDocument()
    expect(timeline.querySelector('svg > path[marker-end]')).not.toBeNull()
  })

  it('同一项目保存任务并更新数据版本后，刷新名称和时间范围', () => {
    const originalTasks = fixture.tasks
    const originalVersion = useDataStore.getState().version
    const { unmount } = render(<Gantt project={fixture.project as Project} />)
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    const originalWidth = parseFloat((timeline.querySelector('.gantt-canvas') as HTMLElement).style.width)
    try {
      fixture.tasks = originalTasks.map((task) => task.id === 't1'
        ? { ...task, name: '更新后的长任务', plannedEnd: '2028-06-30' }
        : task)
      act(() => useDataStore.getState().bump())

      expect(within(timeline).getByRole('button', { name: /更新后的长任务/ })).toHaveAttribute('title', expect.stringContaining('计划结束：2028-06-30'))
      expect(screen.getByText(/项目周期.*2028-07-03/)).toBeInTheDocument()
      expect(parseFloat((timeline.querySelector('.gantt-canvas') as HTMLElement).style.width)).toBeGreaterThan(originalWidth)
    } finally {
      unmount()
      fixture.tasks = originalTasks
      useDataStore.setState({ version: originalVersion })
    }
  })
})
