import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Gantt } from './Gantt'
import type { Project } from '../../types'

const fixture = vi.hoisted(() => ({
  project: { id: 'p1', code: 'PRJ-1', name: '测试项目' },
  sub: { id: 's1', projectId: 'p1', name: '子项目', sortOrder: 1 },
  tasks: [
    { id: 't1', subProjectId: 's1', code: 'T1', name: '长任务', plannedStart: '2026-01-01', plannedEnd: '2026-12-31', isMilestone: false, status: '进行中', progress: 40, estimatedEffort: 30 },
    { id: 't2', subProjectId: 's1', code: 'T2', name: '验收节点', plannedStart: '2027-04-01', plannedEnd: '2027-04-01', isMilestone: true, status: '未开始', progress: 0, estimatedEffort: 0 },
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
  it('连续缩放时间轴、任务、里程碑与依赖线，并保持视图中心', () => {
    render(<Gantt project={fixture.project as Project} />)
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    Object.defineProperty(timeline, 'clientWidth', { configurable: true, value: 500 })
    timeline.scrollLeft = 800
    const canvas = timeline.firstElementChild as HTMLElement
    const task = within(timeline).getByTitle(/长任务/)
    const milestone = within(timeline).getByTitle('验收节点 · 2027-04-01')
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
    fireEvent.change(slider, { target: { value: '100' } })
    expect(screen.getByRole('button', { name: '放大时间轴' })).toBeDisabled()
    expect(slider).toHaveAttribute('aria-valuetext', '日视图，缩放位置 100 / 100')
  })
})
