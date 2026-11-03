export function visibleTimelineWidth(element: HTMLElement, fallbackLabelWidth: number): number {
  const labelWidth = element.querySelector('.gantt-label-column')?.getBoundingClientRect().width || fallbackLabelWidth
  return Math.max(1, element.clientWidth - labelWidth)
}

export function restoreTimelineCenter(element: HTMLElement, centerDay: number, dayWidth: number, totalWidth: number, labelWidth: number) {
  const width = visibleTimelineWidth(element, labelWidth)
  element.scrollLeft = Math.min(Math.max(0, centerDay * dayWidth - width / 2), Math.max(0, totalWidth - width))
}
