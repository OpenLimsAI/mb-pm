import type { CSSProperties, ReactNode, RefObject } from 'react'
import { ColumnResizer } from '../ui/ColumnResizer'
import type { ColumnResizerProps } from '../ui/ColumnResizer'
import './gantt.css'

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>
  labelWidth: number
  resize?: Omit<ColumnResizerProps, 'width' | 'label'>
  timelineWidth: number
  headerHeight: number
  bodyHeight: number
  labelHeader: ReactNode
  labels: ReactNode
  timeHeader: ReactNode
  children: ReactNode
}

/** One scroll owner keeps the date header, task rows and frozen labels aligned. */
export function GanttViewport({ scrollRef, labelWidth, resize, timelineWidth, headerHeight, bodyHeight, labelHeader, labels, timeHeader, children }: Props) {
  return (
    <div ref={scrollRef} role="region" aria-label="甘特图时间轴" tabIndex={0} className="gantt-scroll" style={{
      '--gantt-label-width': `${labelWidth}px`,
      '--gantt-time-width': `${timelineWidth}px`,
      '--gantt-header-height': `${headerHeight}px`,
    } as CSSProperties}>
      <div className="gantt-grid">
        <div className="gantt-label-column">
          <div className="gantt-label-header" style={{ height: headerHeight }}>{labelHeader}</div>
          <div className="relative" style={{ height: bodyHeight }}>{labels}</div>
          {resize && <ColumnResizer {...resize} width={labelWidth} label="调整任务名称列宽" />}
        </div>
        <div className="gantt-canvas" style={{ width: timelineWidth }}>
          <div className="gantt-time-header" style={{ height: headerHeight }}>{timeHeader}</div>
          <div className="relative" style={{ height: bodyHeight }}>{children}</div>
        </div>
      </div>
    </div>
  )
}

