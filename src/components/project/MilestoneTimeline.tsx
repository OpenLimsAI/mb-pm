// 概览页顶部的横向里程碑时间轴 —— 把「项目关键节点」这件最宏观的信息放到最显眼处。
//
// 对应 CTO 反馈 #2：里程碑是更宏观、更重要的视角，应横向置顶；三级 WBS 在其下。
// 节点按计划达成日排序，颜色/倒计时统一走 getTaskSchedule（已完成→绿、逾期→红、临期→黄）。

import { useMemo } from 'react'
import { Diamond, Flame, CheckCircle2, AlertTriangle } from 'lucide-react'
import type { Project, Task } from '../../types'
import { Card, CardHeader, CardBody } from '../ui'
import { getProjectTasks, taskDependencies, TODAY } from '../../mock'
import { computeCPM } from '../../lib/cpm'
import { getTaskSchedule, isTaskDone } from '../../lib/schedule'
import { useDataStore } from '../../store/data'
import { cn } from '../../lib/cn'

interface Props {
  project: Project
  onSelectTask?: (taskId: string) => void
}

export function MilestoneTimeline({ project, onSelectTask }: Props) {
  // 订阅数据版本：里程碑增删/进展变更后刷新路线图
  const version = useDataStore((s) => s.version)
  const milestones = useMemo(() => {
    const tasks = getProjectTasks(project.id)
    const cpm = computeCPM(tasks, taskDependencies)
    return cpm.tasks
      .filter((t) => t.isMilestone)
      .sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, version])

  const doneCount = milestones.filter(isTaskDone).length
  const overdueCount = milestones.filter((m) => getTaskSchedule(m, TODAY).state === 'overdue').length

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Diamond className="w-4 h-4 text-amber-600" />
            里程碑路线图
          </span>
        }
        subtitle={`${milestones.length} 个关键节点 · 已达成 ${doneCount}`}
        action={
          overdueCount > 0
            ? <span className="inline-flex items-center gap-1 text-xs text-red-600 font-medium"><AlertTriangle className="w-3.5 h-3.5" />{overdueCount} 个逾期</span>
            : <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />无逾期节点</span>
        }
      />
      <CardBody className="p-0">
        {milestones.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-500">该项目暂无里程碑</div>
        ) : (
          <div className="overflow-x-auto">
            <div className="flex items-stretch gap-0 px-5 py-5 min-w-max">
              {milestones.map((m, i) => (
                <MilestoneNode
                  key={m.id}
                  milestone={m}
                  isFirst={i === 0}
                  isLast={i === milestones.length - 1}
                  onClick={() => onSelectTask?.(m.id)}
                />
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function MilestoneNode({ milestone, isFirst, isLast, onClick }: {
  milestone: Task
  isFirst: boolean
  isLast: boolean
  onClick: () => void
}) {
  const sch = getTaskSchedule(milestone, TODAY)
  const done = sch.done

  const diamond =
    done ? 'bg-emerald-500 border-emerald-700'
    : sch.state === 'overdue' ? 'bg-red-500 border-red-700'
    : sch.tone === 'amber' ? 'bg-amber-500 border-amber-700'
    : 'bg-brand-500 border-brand-700'

  const line = done ? 'bg-emerald-300' : 'bg-ink-300/60'

  return (
    <div className="flex flex-col items-center w-[150px] shrink-0">
      {/* 连接线 + 菱形节点 */}
      <div className="flex items-center w-full h-7">
        <span className={cn('h-0.5 flex-1', isFirst ? 'opacity-0' : line)} />
        <button
          onClick={onClick}
          className={cn('w-5 h-5 rotate-45 border-2 shrink-0 transition-transform hover:scale-110', diamond)}
          title={milestone.name}
        />
        <span className={cn('h-0.5 flex-1', isLast ? 'opacity-0' : line)} />
      </div>

      {/* 倒计时 / 状态 */}
      <div className={cn(
        'mt-2 text-sm font-semibold leading-none tabular-nums',
        done ? 'text-emerald-600' : sch.state === 'overdue' ? 'text-red-600' : sch.tone === 'amber' ? 'text-amber-600' : 'text-brand-600',
      )}>
        {done ? '已达成' : sch.state === 'overdue' ? `逾期 ${-sch.days}d` : sch.days === 0 ? '今日' : `${sch.days}d`}
      </div>

      {/* 名称 + 日期 */}
      <button onClick={onClick} title={milestone.name} className="mt-1.5 px-1 text-center group">
        <div className="flex items-center justify-center gap-1">
          {milestone.isCriticalPath && <Flame className="w-3 h-3 text-red-500 shrink-0" />}
          <span className="text-xs font-medium text-ink-800 line-clamp-2 group-hover:text-brand-700">{milestone.name}</span>
        </div>
        <div className="text-[10px] text-ink-500 mt-1 font-mono">{milestone.plannedEnd}</div>
      </button>
    </div>
  )
}
