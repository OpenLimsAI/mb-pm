import { Minus, Plus } from 'lucide-react'
import { dayWidthForZoom, scaleForDayWidth, ZOOM_LABELS } from '../../lib/ganttZoom'

export function TimelineZoomControl({ zoom, onChange }: { zoom: number; onChange: (value: number) => void }) {
  const scale = scaleForDayWidth(dayWidthForZoom(zoom))
  return (
    <div className="flex items-center gap-2 text-xs text-ink-700" role="group" aria-label="时间轴缩放">
      <span className="shrink-0">时间缩放</span>
      <button type="button" aria-label="缩小时间轴" title="缩小时间轴" disabled={zoom === 0} onClick={() => onChange(zoom - 5)} className="rounded p-1 hover:bg-ink-100 disabled:opacity-40"><Minus className="h-4 w-4" /></button>
      <div className="w-32 sm:w-40">
        <input type="range" min="0" max="100" step="1" value={zoom} aria-label="时间轴缩放" aria-valuetext={`${ZOOM_LABELS[scale]}视图，缩放位置 ${zoom} / 100`} onChange={(event) => onChange(Number(event.target.value))} className="block h-4 w-full cursor-pointer accent-brand-600" />
        <div className="flex justify-between text-[10px] leading-4 text-ink-500" aria-hidden="true"><span>年</span><span>月</span><span>周</span><span>日</span></div>
      </div>
      <button type="button" aria-label="放大时间轴" title="放大时间轴" disabled={zoom === 100} onClick={() => onChange(zoom + 5)} className="rounded p-1 hover:bg-ink-100 disabled:opacity-40"><Plus className="h-4 w-4" /></button>
    </div>
  )
}
