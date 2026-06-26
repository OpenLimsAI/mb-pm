import { useState } from 'react'
import { Diamond, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { Project, Task } from '../../types'
import { Card, CardHeader, CardBody, Tag, Button } from '../ui'
import { getProjectTasks, subProjects, TODAY } from '../../mock'
import { computeCPM } from '../../lib/cpm'
import { taskDependencies } from '../../mock'
import { isTaskDone } from '../../lib/schedule'
import { useDataStore } from '../../store/data'
import { cn } from '../../lib/cn'
import { MilestoneAssociation } from './MilestoneAssociation'
import { MilestoneEditDrawer, type MilestoneEditTarget } from './MilestoneEditDrawer'

export function MilestonePanel({ project, onOpenTask }: { project: Project; onOpenTask?: (taskId: string) => void }) {
  // 订阅数据版本：里程碑/依赖/任务进展变更后刷新本面板
  useDataStore((s) => s.version)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<MilestoneEditTarget | null>(null)

  const tasks = getProjectTasks(project.id)
  const cpm = computeCPM(tasks, taskDependencies)
  const milestones = cpm.tasks
    .filter((t) => t.isMilestone)
    .sort((a, b) => parseISO(a.plannedEnd).getTime() - parseISO(b.plannedEnd).getTime())

  // 与 mock 数据共用同一「今日」锚点，避免演示日期漂移。
  const today = TODAY

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Diamond className="w-4 h-4 text-amber-600" />
            里程碑（{milestones.length}）
          </span>
        }
        subtitle="点击里程碑查看「哪些任务完成即可达成」；全部前置完成后可标记达成"
        action={
          <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setEditTarget({ mode: 'create' })}>
            新建里程碑
          </Button>
        }
      />
      <CardBody className="p-0">
        {milestones.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-500">
            该项目尚无里程碑。点击右上「新建里程碑」创建，并选择达成它的前置任务。
          </div>
        ) : (
          <ol className="relative">
            {milestones.map((m, idx) => {
              const isDone = isTaskDone(m)
              const daysLeft = differenceInCalendarDays(parseISO(m.plannedEnd), today)
              const isOverdue = !isDone && daysLeft < 0
              const isUrgent = !isDone && daysLeft >= 0 && daysLeft <= 14
              const preds = taskDependencies.filter((d) => d.successorId === m.id)
              const predsDone = preds.filter((d) => {
                const p = cpm.byId.get(d.predecessorId)
                return p?.status === '已完成' || p?.status === '已验证'
              }).length
              const canReview = preds.length > 0 && predsDone === preds.length
              const sub = subProjects.find((s) => s.id === m.subProjectId)
              const expanded = expandedId === m.id

              return (
                <li key={m.id} className="relative border-b border-ink-300/30 last:border-b-0">
                  {/* 里程碑行（可点击展开） */}
                  <div
                    className="flex gap-3 px-4 py-3 hover:bg-ink-100/40 cursor-pointer"
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                  >
                    {/* 时间线竖线 */}
                    {idx < milestones.length - 1 && !expanded && (
                      <span className="absolute left-[26px] top-9 bottom-0 w-px bg-ink-300/60" />
                    )}
                    <div className={cn(
                      'w-7 h-7 rotate-45 shrink-0 border-2 z-10',
                      isDone && 'bg-emerald-500 border-emerald-700',
                      isOverdue && 'bg-red-500 border-red-700',
                      isUrgent && 'bg-amber-500 border-amber-700',
                      !isDone && !isOverdue && !isUrgent && 'bg-brand-500 border-brand-700'
                    )} />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-ink-500" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-400" />}
                            <span className="font-mono text-[10px] text-ink-500">{m.code}</span>
                            {m.isOnCriticalPath && <Tag tone="red">关键路径</Tag>}
                            {canReview && !isDone && <Tag tone="green" className="gap-1"><CheckCircle2 className="w-3 h-3" />可达成</Tag>}
                            {isOverdue && <Tag tone="red" className="gap-1"><AlertTriangle className="w-3 h-3" />已逾期</Tag>}
                          </div>
                          <div className="text-sm font-semibold text-ink-900 mt-0.5">{m.name}</div>
                          <div className="text-xs text-ink-500 mt-0.5">
                            {sub?.name} · 计划达成 {m.plannedEnd}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          {isDone ? (
                            <Tag tone="green">已达成</Tag>
                          ) : (
                            <>
                              <div className={cn(
                                'text-xl font-semibold leading-none',
                                isOverdue ? 'text-red-600' : isUrgent ? 'text-amber-600' : 'text-brand-600'
                              )}>
                                {Math.abs(daysLeft)}
                              </div>
                              <div className="text-[10px] text-ink-500 mt-0.5">{isOverdue ? '天逾期' : '天后'}</div>
                            </>
                          )}
                        </div>
                      </div>

                      {/* 前置任务进度（收起态显示概览） */}
                      {!expanded && preds.length > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-[11px] text-ink-500 shrink-0">达成条件</span>
                          <div className="flex-1 h-1.5 bg-ink-100 rounded">
                            <div
                              className={cn('h-full rounded', predsDone === preds.length ? 'bg-emerald-500' : 'bg-brand-500')}
                              style={{ width: `${(predsDone / preds.length) * 100}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-mono text-ink-700">{predsDone}/{preds.length}</span>
                        </div>
                      )}

                      {/* 展开：关联任务详情 + 设置入口 */}
                      {expanded && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <MilestoneAssociation
                            milestone={m}
                            onEdit={() => setEditTarget({ mode: 'edit', milestone: m as Task })}
                            onOpenTask={onOpenTask}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </CardBody>

      {editTarget && (
        <MilestoneEditDrawer
          // key 绑定到目标身份：create↔edit 或切换里程碑时强制重挂载，
          // 保证表单 useState 初值重置（防止未来若改为常驻挂载时出现 stale-state）。
          key={editTarget.mode === 'edit' ? editTarget.milestone.id : 'create'}
          target={editTarget}
          project={project}
          onClose={() => setEditTarget(null)}
        />
      )}
    </Card>
  )
}
