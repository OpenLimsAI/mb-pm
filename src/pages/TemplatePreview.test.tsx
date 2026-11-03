import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, it } from 'vitest'
import TemplatePreview from './TemplatePreview'
import { useTemplatesStore } from '../store/templates'

it('模拟甘特图使用同一固定列视口，任务名保留全文且列宽可调整', () => {
  const template = useTemplatesStore.getState().templates[0]
  const version = template.versions.find(item => item.isCurrent)!
  const sub = version.structureJson.children![0]
  const task = sub.children![0]
  const view = render(<MemoryRouter initialEntries={[`/templates/${template.id}/preview`]}><Routes><Route path="/templates/:id/preview" element={<TemplatePreview />} /></Routes></MemoryRouter>)
  try {
    const timeline = screen.getByRole('region', { name: '甘特图时间轴' })
    const labels = timeline.querySelector('.gantt-label-column') as HTMLElement
    expect(within(labels).getByText(sub.name)).toHaveAttribute('title', sub.name)
    expect(within(labels).getByText(task.name)).toHaveAttribute('title', task.name)
    const divider = screen.getByRole('separator', { name: '调整任务名称列宽' })
    const canvas = timeline.querySelector('.gantt-canvas') as HTMLElement
    const timelineWidth = canvas.style.width
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(timeline.style.getPropertyValue('--gantt-label-width')).toBe('336px')
    expect(canvas.style.width).toBe(timelineWidth)
    expect(timeline.querySelectorAll('.gantt-label-header')).toHaveLength(1)
    expect(timeline.querySelectorAll('.gantt-time-header')).toHaveLength(1)
  } finally {
    view.unmount()
    localStorage.removeItem('pm-column:template-gantt')
  }
})
