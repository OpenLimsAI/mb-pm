import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { addDays, differenceInCalendarDays, parseISO } from 'date-fns'
import { describe, expect, it, vi } from 'vitest'
import { MultiProjectGantt } from './Gantt'
import type { Project } from '../types'

const fixture = vi.hoisted(() => ({
  project: { id: 'p1', code: 'PRJ-1', name: '测试项目', health: 'green' },
  sub: { id: 's1', projectId: 'p1', sortOrder: 1 },
  tasks: [
    { id: 't1', subProjectId: 's1', code: 'T1', name: '长任务', plannedStart: '2026-01-01', plannedEnd: '2026-12-31', isMilestone: false, status: '进行中', progress: 40, estimatedEffort: 30 },
    { id: 't2', subProjectId: 's1', code: 'T2', name: '验收节点', plannedStart: '2027-04-01', plannedEnd: '2027-04-01', isMilestone: true, status: '未开始', progress: 0, estimatedEffort: 0 },
  ],
}))

vi.mock('../mock', async (importOriginal) => ({
  ...await importOriginal<typeof import('../mock')>(),
  getProjectSubs: () => [fixture.sub],
  getSubTasks: () => fixture.tasks,
  getProjectTasks: () => fixture.tasks,
  findUser: () => undefined,
  taskDependencies: [],
  TODAY: new Date(2026, 5, 15),
}))

describe('多项目甘特图时间轴缩放', () => {
  it('连续缩放任务、里程碑、今日线和跨年刻度，并保留可见时间位置', () => {
    render(<MemoryRouter><MultiProjectGantt projects={[fixture.project as Project]} version={0} /></MemoryRouter>)
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    Object.defineProperty(timeline, 'clientWidth', { configurable: true, value: 500 })
    timeline.scrollLeft = 800
    const canvas = timeline.firstElementChild as HTMLElement
    const task = within(timeline).getByTitle(/长任务.*2026-01-01.*2026-12-31/)
    const milestone = within(timeline).getByTitle('验收节点 · 2027-04-01')
    const today = within(timeline).getByRole('img', { name: '今日 2026-06-15' })
    const start = addDays(parseISO('2026-01-01'), -7)
    const daysToToday = differenceInCalendarDays(new Date(2026, 5, 15), start)
    const daysToMilestone = differenceInCalendarDays(parseISO('2027-04-01'), start)
    const originalWidth = parseFloat(canvas.style.width)
    const originalTaskWidth = parseFloat(task.style.width)
    const slider = screen.getByRole('slider', { name: '时间轴缩放' })
    expect(slider).toHaveValue('66')
    expect(slider).toHaveAttribute('aria-valuetext', '周视图，缩放位置 66 / 100')
    expect(parseFloat(today.style.left)).toBe(daysToToday * 8)

    fireEvent.change(slider, { target: { value: '33' } })
    expect(slider).toHaveAttribute('aria-valuetext', '月视图，缩放位置 33 / 100')
    expect(parseFloat(canvas.style.width)).toBeCloseTo(originalWidth * 3 / 8)
    expect(parseFloat(task.style.width)).toBeCloseTo(originalTaskWidth * 3 / 8)
    expect(parseFloat(milestone.style.left)).toBeCloseTo(daysToMilestone * 3 - 6)
    expect(parseFloat(today.style.left)).toBe(daysToToday * 3)
    expect(timeline.scrollLeft).toBeCloseTo((800 + 250) / 8 * 3 - 250)
    expect(within(timeline).getByText('2026-01')).toBeInTheDocument()

    const monthWidth = parseFloat(canvas.style.width)
    fireEvent.change(slider, { target: { value: '45' } })
    const intermediateWidth = parseFloat(canvas.style.width)
    expect(intermediateWidth).toBeGreaterThan(monthWidth)
    expect(intermediateWidth).toBeLessThan(originalWidth)
    expect(parseFloat(task.style.width) / originalTaskWidth).toBeCloseTo(intermediateWidth / originalWidth)
    expect(parseFloat(today.style.left) / daysToToday).toBeCloseTo(intermediateWidth / (originalWidth / 8))
    expect(timeline.scrollLeft).toBeCloseTo((800 + 250) / 8 * (intermediateWidth / (originalWidth / 8)) - 250)
    fireEvent.change(slider, { target: { value: '46' } })
    expect(parseFloat(canvas.style.width)).toBeGreaterThan(intermediateWidth)

    fireEvent.change(slider, { target: { value: '0' } })
    expect(parseFloat(canvas.style.width)).toBeCloseTo(originalWidth * 0.6 / 8)
    expect(parseFloat(today.style.left)).toBe(daysToToday * 0.6)
    expect(within(timeline).getByText('2026')).toBeInTheDocument()
    expect(within(timeline).getAllByText('Q1').length).toBeGreaterThan(0)
    expect(timeline.scrollLeft).toBe(0)
    expect(screen.getByRole('button', { name: '缩小时间轴' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '放大时间轴' }))
    expect(slider).toHaveValue('5')
    expect(parseFloat(canvas.style.width)).toBeGreaterThan(originalWidth * 0.6 / 8)

    // 全部时间已在屏幕内时，再放大应以时间轴中心为锚点，而非空白区域。
    fireEvent.change(slider, { target: { value: '33' } })
    expect(timeline.scrollLeft).toBeCloseTo((originalWidth / 8 / 2) * 3 - 250)

    fireEvent.change(slider, { target: { value: '100' } })
    expect(parseFloat(canvas.style.width)).toBeCloseTo(originalWidth * 18 / 8)
    expect(parseFloat(task.style.width)).toBeCloseTo(originalTaskWidth * 18 / 8)
    expect(parseFloat(today.style.left)).toBe(daysToToday * 18)
    expect(slider).toHaveAttribute('aria-valuetext', '日视图，缩放位置 100 / 100')
    expect(screen.getByRole('button', { name: '放大时间轴' })).toBeDisabled()
  })
})
