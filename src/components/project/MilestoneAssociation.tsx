// 里程碑「达成条件」展开区：清晰呈现【哪些 WBS 任务完成 → 该里程碑达成】。
//
// 数据：以该里程碑为 successor 的 FS 依赖前驱即为达成条件任务。按子项目（模块）分组，
// 每个任务显示完成状态；全部完成即「可评审/可达成」，一键标记达成。

import { useState } from 'react'
import {
  CheckCircle2, Clock, Circle, PencilLine, AlertTriangle, Loader2, Trophy, ChevronRight,
} from 'lucide-react'
import type { Task } from '../../types'
import { StatusTag, Avatar, Button } from '../ui'
import { taskDependencies, findTask, findUser, subProjects } from '../../mock'
import { isTaskDone } from '../../lib/schedule'
import { updateTaskProgress } from '../../data/bootstrap'
import { cn } from '../../lib/cn'

interface Props {
  milestone: Task
  onEdit: () => void
  onOpenTask?: (taskId: string) => void
}

export function MilestoneAssociation({ milestone, onEdit, onOpenTask }: Props) {
  const [marking, setMarking] = useState(false)

  const preds = taskDependencies.filter((d) => d.successorId === milestone.id)
  const resolved = preds.map((d) => ({ dep: d, task: findTask(d.predecessorId) }))
  const valid = resolved.filter((x): x is { dep: typeof x.dep; task: Task } => !!x.task)
  const orphanCount = resolved.length - valid.length
  const doneCount = valid.filter((x) => isTaskDone(x.task)).length
  const total = valid.length
  const milestoneDone = isTaskDone(milestone)
  const canReview = total > 0 && doneCount === total && !milestoneDone

  // 按子项目（模块）分组
  const groups = new Map<string, Task[]>()
  for (const { task } of valid) {
    const arr = groups.get(task.subProjectId) ?? []
    arr.push(task)
    groups.set(task.subProjectId, arr)
  }

  const markAchieved = async () => {
    setMarking(true)
    try {
      await updateTaskProgress(milestone.id, { status: '已验证', progress: 100 })
    } finally {
      setMarking(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-300/50 bg-ink-100/30">
      {/* 操作条 + 汇总 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-300/40 flex-wrap">
        <span className="text-xs font-medium text-ink-700">达成条件</span>
        {total > 0 ? (
          <span className={cn('text-xs font-medium', canReview ? 'text-emerald-600' : 'text-ink-500')}>
            已完成 {doneCount}/{total} 个前置任务
          </span>
        ) : (
          <span className="text-xs text-ink-500">暂无前置任务，可直接评审</span>
        )}
        {orphanCount > 0 && (
          <span className="text-[11px] text-amber-600 inline-flex items-center gap-0.5">
            <AlertTriangle className="w-3 h-3" />{orphanCount} 个前置已失效
          </span>
        )}
        <div className="flex-1" />
        {canReview && (
          <Button
            size="sm" variant="primary"
            icon={marking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trophy className="w-3.5 h-3.5" />}
            disabled={marking}
            onClick={markAchieved}
          >
            标记达成
          </Button>
        )}
        <Button size="sm" variant="secondary" icon={<PencilLine className="w-3.5 h-3.5" />} onClick={onEdit}>
          设置
        </Button>
      </div>

      {/* 达成进度条 */}
      {total > 0 && (
        <div className="px-3 pt-2.5">
          <div className="h-1.5 bg-ink-200 rounded">
            <div
              className={cn('h-full rounded', canReview ? 'bg-emerald-500' : 'bg-brand-500')}
              style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* 前置任务分组表 */}
      {total > 0 && (
        <div className="p-2 space-y-2.5">
          {[...groups.entries()].map(([subId, gtasks]) => {
            const sub = subProjects.find((s) => s.id === subId)
            return (
              <div key={subId}>
                <div className="flex items-center gap-1.5 px-1.5 pb-1">
                  <span className="tag bg-purple-100 text-purple-800 font-mono text-[9px]">{sub?.module ?? '—'}</span>
                  <span className="text-[11px] font-medium text-ink-600">{sub?.name ?? '未知子项目'}</span>
                </div>
                <ul className="space-y-0.5">
                  {gtasks.map((t) => (
                    <PredRow key={t.id} task={t} onOpen={onOpenTask} />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PredRow({ task, onOpen }: { task: Task; onOpen?: (id: string) => void }) {
  const owner = findUser(task.ownerId)
  const done = isTaskDone(task)
  const inProgress = task.status === '进行中'

  const Icon = done ? CheckCircle2 : inProgress ? Clock : Circle
  const iconColor = done ? 'text-emerald-500' : inProgress ? 'text-brand-500' : 'text-ink-400'

  return (
    <li>
      <button
        onClick={() => onOpen?.(task.id)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white text-left group"
      >
        <Icon className={cn('w-4 h-4 shrink-0', iconColor)} />
        <span className="font-mono text-[10px] text-ink-400 shrink-0">{task.code}</span>
        <span className={cn('text-xs truncate flex-1', done && 'text-ink-500')}>{task.name}</span>
        {owner && <Avatar user={owner} size="sm" />}
        <StatusTag status={task.status} />
        <ChevronRight className="w-3 h-3 text-ink-300 group-hover:text-ink-500 shrink-0" />
      </button>
    </li>
  )
}
