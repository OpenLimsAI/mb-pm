// URS 4.5 状态流转可视化
// 未开始 → 进行中 → 已完成 / 已验证
// 进行中 → 阻塞 → 进行中
// 进行中 → 延迟（自动或手动标记）

import type { TaskStatus } from '../../types'
import { cn } from '../../lib/cn'
import { PRIMARY_TASK_STATUSES, primaryTaskStatus } from '../../lib/taskStatus'

const primaryTones = {
  未开始: 'bg-ink-300 text-white',
  进行中: 'bg-brand-500 text-white',
  已完成: 'bg-emerald-500 text-white',
  已验证: 'bg-emerald-700 text-white',
}

const sideStates: { value: TaskStatus; label: string; tone: string }[] = [
  { value: '阻塞', label: '阻塞', tone: 'bg-purple-500 text-white' },
  { value: '延迟', label: '延迟', tone: 'bg-red-500 text-white' },
]

export function TaskStatusFlow({ current }: { current: TaskStatus }) {
  const primary = primaryTaskStatus(current)
  return (
    <div className="space-y-2">
      {/* 主流程 */}
      <div className="flex items-center gap-1.5">
        {PRIMARY_TASK_STATUSES.map((s, i) => {
          const isCurrent = primary === s
          const isPassed = PRIMARY_TASK_STATUSES.indexOf(primary) > i
          return (
            <div key={s} className="flex items-center gap-1.5 flex-1">
              <div
                className={cn(
                  'flex-1 px-2 py-1.5 rounded text-xs text-center font-medium border-2 transition-all',
                  isCurrent
                    ? `${primaryTones[s]} border-transparent ring-2 ring-offset-1 ring-brand-300`
                    : isPassed
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-ink-100 text-ink-500 border-transparent'
                )}
              >
                {s}
                {isCurrent && <span className="ml-1">●</span>}
              </div>
              {i < PRIMARY_TASK_STATUSES.length - 1 && (
                <span className="text-ink-300 text-xs">→</span>
              )}
            </div>
          )
        })}
      </div>

      {/* 副流程：阻塞 / 延迟 */}
      <div className="flex items-center gap-2 pl-1">
        <span className="text-[10px] text-ink-500 uppercase">副状态</span>
        {sideStates.map((s) => (
          <div
            key={s.value}
            className={cn(
              'px-2 py-0.5 rounded text-[11px] font-medium',
              current === s.value
                ? `${s.tone} ring-2 ring-offset-1 ring-brand-300`
                : 'bg-ink-100 text-ink-500'
            )}
          >
            {s.label} {current === s.value && '●'}
          </div>
        ))}
      </div>
    </div>
  )
}
