export type TimelineZoom = 'year' | 'month' | 'week' | 'day'
const ZOOM_STOPS = [
  { position: 0, dayWidth: 0.6 },
  { position: 33, dayWidth: 3 },
  { position: 66, dayWidth: 8 },
  { position: 100, dayWidth: 18 },
]
export const ZOOM_LABELS: Record<TimelineZoom, string> = { year: '年', month: '月', week: '周', day: '日' }

export function dayWidthForZoom(position: number): number {
  const stop = ZOOM_STOPS.findIndex((item) => item.position >= position)
  if (stop <= 0) return ZOOM_STOPS[0].dayWidth
  const previous = ZOOM_STOPS[stop - 1]
  const next = ZOOM_STOPS[stop]
  const progress = (position - previous.position) / (next.position - previous.position)
  return previous.dayWidth * (next.dayWidth / previous.dayWidth) ** progress
}

export function scaleForDayWidth(dayWidth: number): TimelineZoom {
  if (dayWidth < 2) return 'year'
  if (dayWidth < 5) return 'month'
  if (dayWidth < 14) return 'week'
  return 'day'
}
