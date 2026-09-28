// 延迟影响推演（FR-PJ-004）：选定任务 + 延迟天数，沿依赖链推算下游影响与项目完工顺延。
// 纯前端推演，不改动计划数据。

import { useMemo, useState, type ReactNode } from 'react'
import { Zap, AlertTriangle, ArrowDown, Diamond, Flame, CalendarClock } from 'lucide-react'
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Button, Tag } from '../ui'
import { getProjectTasks, taskDependencies } from '../../mock'
import { computeCPM, simulateDelay } from '../../lib/cpm'
import { useDataStore } from '../../store/data'
import { cn } from '../../lib/cn'

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)

export function DelayImpact({ project }: { project: Project }) {
  // 订阅数据版本：任务 / 依赖保存后重新推演
  const version = useDataStore((s) => s.version)
  const tasks = useMemo(
    () => getProjectTasks(project.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.id, version],
  )
  const cpm = useMemo(() => computeCPM(tasks, taskDependencies), [tasks])
  const candidates = useMemo(() => tasks.filter((t) => !t.isMilestone), [tasks])

  const [pickedId, setPickedId] = useState<string>('')
  const [delay, setDelay] = useState<number>(7)

  // 默认选第一个关键路径任务；所选任务被删除时回落到默认
  const taskId = candidates.some((t) => t.id === pickedId)
    ? pickedId
    : (candidates.find((t) => cpm.byId.get(t.id)?.isOnCriticalPath) ?? candidates[0])?.id ?? ''

  const impacts = useMemo(() => {
    if (!taskId || delay === 0) return []
    return simulateDelay(cpm, taskDependencies, taskId, delay)
  }, [cpm, taskId, delay])

  const startTask = cpm.byId.get(taskId)
  const milestoneCount = impacts.filter((i) => i.affectsMilestone).length
  const criticalCount = impacts.filter((i) => i.affectsCritical).length

  // 项目完工日：受影响任务的新结束日与原计划最晚结束日取较晚者
  const finishShift = useMemo(() => {
    if (!startTask || tasks.length === 0 || delay <= 0) return 0
    const currentEnd = tasks.reduce((m, t) => (t.plannedEnd > m ? t.plannedEnd : m), tasks[0].plannedEnd)
    const startNewEnd = format(addDays(parseISO(startTask.plannedEnd), delay), 'yyyy-MM-dd')
    const newEnd = [startNewEnd, ...impacts.map((i) => i.newPlannedEnd)].reduce((m, d) => (d > m ? d : m), currentEnd)
    return Math.max(0, differenceInCalendarDays(parseISO(newEnd), parseISO(currentEnd)))
  }, [startTask, tasks, impacts, delay])

  if (candidates.length === 0) {
    return (
      <Card>
        <CardBody className="p-8 text-center text-sm text-ink-500">该项目暂无可推演的任务</CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-600" />
            延迟影响推演
          </span>
        }
        subtitle="选定任务并输入延迟天数，沿依赖链推算下游影响（仅推演，不修改计划）"
      />
      <CardBody>
        {/* 输入区 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 pb-4 border-b border-ink-300/40">
          <div>
            <label className="block text-xs text-ink-700 mb-1">起始任务</label>
            <select
              value={taskId}
              onChange={(e) => setPickedId(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-ink-300 bg-white"
            >
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} - {t.name}
                  {cpm.byId.get(t.id)?.isOnCriticalPath ? '（关键路径）' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-700 mb-1">延迟天数（负数表示提前）</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={delay}
                onChange={(e) => setDelay(parseInt(e.target.value || '0', 10) || 0)}
                className="w-24 px-2.5 py-1.5 text-sm rounded-md border border-ink-300"
              />
              <div className="inline-flex border border-ink-300 rounded-md">
                {[3, 7, 14, 30].map((v) => (
                  <button
                    key={v}
                    onClick={() => setDelay(v)}
                    className={cn(
                      'px-2 py-1 text-xs',
                      delay === v ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-100',
                      v !== 3 && 'border-l border-ink-300'
                    )}
                  >
                    +{v}d
                  </button>
                ))}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setDelay(0)}>清空</Button>
            </div>
          </div>
        </div>

        {/* 概览 */}
        {startTask && (
          <div className="mb-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="受影响任务" value={impacts.length} tone={impacts.length > 5 ? 'red' : 'amber'} icon={<ArrowDown className="w-4 h-4" />} />
            <Stat label="关键路径任务" value={criticalCount} tone={criticalCount > 0 ? 'red' : 'gray'} icon={<Flame className="w-4 h-4" />} />
            <Stat label="受影响里程碑" value={milestoneCount} tone={milestoneCount > 0 ? 'red' : 'gray'} icon={<Diamond className="w-4 h-4" />} />
            <Stat
              label="项目完工顺延（天）"
              value={finishShift}
              tone={finishShift > 0 ? 'red' : 'gray'}
              icon={<CalendarClock className="w-4 h-4" />}
            />
          </div>
        )}

        {/* 传导链路 */}
        {impacts.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-500">
            {delay === 0 ? '请输入延迟天数' : '该任务无下游依赖，不会传导影响'}
          </div>
        ) : (
          <div>
            <h4 className="text-sm font-medium text-ink-900 mb-2">传导链路</h4>
            <div className="space-y-2">
              {startTask && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200">
                  <Zap className="w-4 h-4 text-amber-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink-900">{startTask.name}</div>
                    <div className="text-xs text-ink-500 mt-0.5">
                      <span className="font-mono">{startTask.code}</span> · 起始{delay > 0 ? '延迟' : '提前'} {signed(delay)} 天
                    </div>
                  </div>
                </div>
              )}

              {impacts.map((imp) => (
                <div
                  key={imp.taskId}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-md border ml-4',
                    imp.affectsMilestone
                      ? 'bg-red-50 border-red-200'
                      : imp.affectsCritical
                      ? 'bg-orange-50 border-orange-200'
                      : 'bg-ink-100 border-ink-300/60'
                  )}
                >
                  <ArrowDown className="w-3.5 h-3.5 text-ink-500 shrink-0" />
                  <span className="text-[10px] text-ink-500 font-mono">+{imp.hops}跳</span>
                  {imp.affectsMilestone && <Diamond className="w-3.5 h-3.5 text-red-500" />}
                  {imp.affectsCritical && !imp.affectsMilestone && <Flame className="w-3.5 h-3.5 text-red-500" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink-900 truncate">{imp.taskName}</div>
                    <div className="text-xs text-ink-500 mt-0.5">
                      <span className="font-mono">{imp.taskCode}</span> · 计划结束改为{' '}
                      <span className="text-red-600 font-mono">{imp.newPlannedEnd}</span>
                    </div>
                  </div>
                  <Tag tone={imp.shiftDays > 0 ? 'red' : 'green'}>{signed(imp.shiftDays)}d</Tag>
                </div>
              ))}
            </div>

            {milestoneCount > 0 && delay > 0 && (
              <div className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-medium text-red-700">里程碑风险预警</div>
                  <div className="text-red-700/80 mt-0.5">
                    本次延迟将导致 {milestoneCount} 个里程碑同步推迟
                    {finishShift > 0 ? `，项目完工顺延 ${finishShift} 天` : ''}，建议调整资源或评估优先级。
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function Stat({ label, value, tone, icon }: { label: string; value: number; tone: 'red' | 'amber' | 'gray'; icon: ReactNode }) {
  const map = {
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    gray: 'bg-ink-100 text-ink-700',
  }
  return (
    <div className={cn('rounded-md p-3 flex items-center gap-3', map[tone])}>
      <div>{icon}</div>
      <div>
        <div className="text-xl font-semibold leading-none">{value}</div>
        <div className="text-xs mt-0.5">{label}</div>
      </div>
    </div>
  )
}
