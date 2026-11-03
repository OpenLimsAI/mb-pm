// 个人看板（FR-DB-002）：研发 / 生产 / QA 账号的首页；管理者也可在首页切换查看。
// (a) 我的 KPI 与本周负荷  (b) Kanban 三列  (c) 我的待办  (d) 我参与的项目
// 点击任务打开任务抽屉，直接录入状态 / 进度 / 实际日期（写入后端）。

import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Diamond, Flame, ListTodo, Calendar, ChevronRight } from 'lucide-react'
import { differenceInCalendarDays, parseISO, format, startOfWeek, addDays } from 'date-fns'
import {
  tasks as allTasks, calcWorkload,
  findSubProject, findProject, findTask, TODAY,
} from '../../mock'
import { useDataStore } from '../../store/data'
import type { Task, User, TaskStatus } from '../../types'
import { Card, CardHeader, CardBody, Tag, StatusTag, PriorityTag } from '../ui'
import { TaskDrawer } from '../task/TaskDrawer'
import { cn } from '../../lib/cn'

const KANBAN_COLS: { key: TaskStatus[]; label: string; tone: string }[] = [
  { key: ['未开始'], label: '未开始', tone: 'border-ink-300 bg-ink-100' },
  { key: ['进行中', '阻塞', '延迟'], label: '进行中 / 阻塞 / 延迟', tone: 'border-brand-300 bg-brand-50' },
  { key: ['已完成', '已验证'], label: '已完成', tone: 'border-emerald-300 bg-emerald-50' },
]

export function PersonalKanban({ user }: { user: User }) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  // 订阅数据版本：抽屉里保存进展后看板随之刷新
  const version = useDataStore((s) => s.version)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const myTasks = useMemo(() => allTasks.filter((t) => t.ownerId === user.id), [user.id, version])
  const workload = calcWorkload(user.id)
  const w = workload.rate
  const level: 'low' | 'mid' | 'high' = w <= 70 ? 'low' : w <= 90 ? 'mid' : 'high'

  // KPIs
  const todo = myTasks.filter((t) => t.status === '未开始').length
  const wip = myTasks.filter((t) => t.status === '进行中' || t.status === '阻塞' || t.status === '延迟').length
  const today = TODAY  // 与全局一致的「今日」锚点
  const startWeek = startOfWeek(today, { weekStartsOn: 1 })
  const endWeek = addDays(startWeek, 6)
  const doneThisWeek = myTasks.filter((t) => {
    if (t.status !== '已完成' && t.status !== '已验证') return false
    if (!t.actualEnd) return false
    const ae = parseISO(t.actualEnd)
    return ae >= startWeek && ae <= endWeek
  }).length

  // 我参与的项目
  const myProjects = Array.from(new Set(
    myTasks.map((t) => findSubProject(t.subProjectId)?.projectId).filter(Boolean) as string[]
  )).map((id) => {
    const p = findProject(id)
    if (!p) return null
    const myInThis = myTasks.filter((t) => findSubProject(t.subProjectId)?.projectId === id)
    return { project: p, taskCount: myInThis.length, doneCount: myInThis.filter((t) => t.status === '已完成' || t.status === '已验证').length }
  }).filter((x): x is NonNullable<typeof x> => x !== null)

  // 待办（按优先级 + 截止时间排序）
  const todoList = [...myTasks]
    .filter((t) => t.status !== '已完成' && t.status !== '已验证')
    .sort((a, b) => {
      const prMap: Record<string, number> = { '高': 0, '中': 1, '低': 2 }
      const dp = prMap[a.priority] - prMap[b.priority]
      if (dp !== 0) return dp
      return parseISO(a.plannedEnd).getTime() - parseISO(b.plannedEnd).getTime()
    })
    .slice(0, 8)

  return (
    <>
      {/* 个人 KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <KpiCard label="我的待办" value={todo} icon={<ListTodo className="w-5 h-5" />} tone="blue" />
        <KpiCard label="进行中" value={wip} icon={<Flame className="w-5 h-5" />} tone="amber" />
        <KpiCard label="本周完成" value={doneThisWeek} icon={<Diamond className="w-5 h-5" />} tone="green" />
        <div className={cn(
          'card p-4 flex items-center gap-3',
          level === 'high' ? 'bg-red-50' : level === 'mid' ? 'bg-amber-50' : 'bg-emerald-50'
        )}>
          <div className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center',
            level === 'high' ? 'bg-red-100 text-red-600' : level === 'mid' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'
          )}>
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <div className={cn(
              'text-2xl font-semibold leading-none',
              level === 'high' ? 'text-red-600' : level === 'mid' ? 'text-amber-600' : 'text-emerald-600'
            )}>{w}%</div>
            <div className="text-xs text-ink-700 mt-1">本周负荷 ({workload.allocatedHours}/{workload.availableHours}h)</div>
          </div>
        </div>
      </div>

      {/* Kanban 三列 */}
      <Card className="mb-4">
        <CardHeader
          title="任务看板（Kanban）"
          subtitle="按状态分列 · 点击任务录入状态 / 进度 / 实际日期"
        />
        <CardBody>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {KANBAN_COLS.map((col) => {
              const cards = myTasks.filter((t) => col.key.some((s) => s === t.status))
              return (
                <div
                  key={col.label}
                  className={cn('rounded-md border-t-4 p-3 min-h-[200px]', col.tone)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium text-sm text-ink-900">{col.label}</h4>
                    <Tag tone="gray">{cards.length}</Tag>
                  </div>
                  <div className="space-y-2">
                    {cards.length === 0 ? (
                      <div className="text-center py-6 text-xs text-ink-500 italic">暂无任务</div>
                    ) : (
                      cards.map((t) => <KanbanCard key={t.id} task={t} onOpen={() => setOpenTaskId(t.id)} />)
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardBody>
      </Card>

      {/* 待办 + 我参与的项目 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="我的待办（按优先级 + 截止排序）" subtitle="点击进入任务详情" />
          <CardBody className="p-0">
            {todoList.length === 0 ? (
              <div className="p-6 text-center text-sm text-ink-500">暂无待办</div>
            ) : (
              <ul className="divide-y divide-ink-300/40">
                {todoList.map((t) => {
                  const sub = findSubProject(t.subProjectId)
                  const project = sub ? findProject(sub.projectId) : null
                  const daysToEnd = differenceInCalendarDays(parseISO(t.plannedEnd), today)
                  return (
                    <li
                      key={t.id}
                      className="px-4 py-3 flex items-center gap-3 hover:bg-ink-100/40 cursor-pointer"
                      onClick={() => setOpenTaskId(t.id)}
                    >
                      <PriorityTag priority={t.priority} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] text-ink-500">{t.code}</span>
                          {t.isCriticalPath && <Flame className="w-3 h-3 text-red-500" />}
                          {t.isMilestone && <Diamond className="w-3 h-3 text-amber-600" />}
                        </div>
                        <div className="text-sm text-ink-900 truncate" title={t.name}>{t.name}</div>
                        <div className="text-[11px] text-ink-500 truncate" title={[project?.code, project?.name, sub?.name].filter(Boolean).join(' · ')}>{project?.code} · {sub?.name}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <StatusTag status={t.status} />
                        <div className={cn(
                          'text-[11px] font-mono mt-1',
                          daysToEnd < 0 ? 'text-red-600' : daysToEnd <= 3 ? 'text-amber-600' : 'text-ink-500'
                        )}>
                          {daysToEnd < 0 ? `逾期 ${-daysToEnd}d` : `${daysToEnd}d 到期`}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={`我参与的项目（${myProjects.length}）`} subtitle="所有有我负责任务的项目" />
          <CardBody className="p-0">
            {myProjects.length === 0 ? (
              <div className="p-6 text-center text-sm text-ink-500">暂无参与项目</div>
            ) : (
              <ul className="divide-y divide-ink-300/40">
                {myProjects.map((mp) => (
                  <li key={mp.project.id} className="px-4 py-3 hover:bg-ink-100/40">
                    <Link to={`/projects/${mp.project.id}`} className="flex items-center gap-3 w-full">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="font-mono text-[10px] text-ink-500">{mp.project.code}</span>
                          <Tag tone={mp.project.health === 'red' ? 'red' : mp.project.health === 'yellow' ? 'yellow' : 'green'}>
                            {mp.project.health === 'red' ? '风险' : mp.project.health === 'yellow' ? '关注' : '健康'}
                          </Tag>
                        </div>
                        <div className="text-sm font-medium text-ink-900 truncate" title={mp.project.name}>{mp.project.name}</div>
                        <div className="text-[11px] text-ink-500 mt-0.5">
                          我有 {mp.taskCount} 个任务（已完成 {mp.doneCount}）
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-ink-500" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <TaskDrawer task={openTaskId ? findTask(openTaskId) || null : null} onClose={() => setOpenTaskId(null)} />
    </>
  )
}

function KanbanCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const sub = findSubProject(task.subProjectId)
  const project = sub ? findProject(sub.projectId) : null
  const daysToEnd = differenceInCalendarDays(parseISO(task.plannedEnd), TODAY)
  return (
    <button
      onClick={onOpen}
      className="w-full text-left bg-white rounded-md border border-ink-300/60 p-2.5 hover:shadow-card-hover transition-shadow cursor-pointer"
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="font-mono text-[10px] text-ink-500">{task.code}</span>
        {task.isMilestone && <Diamond className="w-3 h-3 text-amber-600" />}
        {task.isCriticalPath && <Flame className="w-3 h-3 text-red-500" />}
        <PriorityTag priority={task.priority} />
      </div>
      <div className="text-sm font-medium text-ink-900">{task.name}</div>
      {project && (
        <div className="text-[11px] text-ink-500 mt-1 truncate" title={[project.code, project.name, sub?.name].filter(Boolean).join(' · ')}>{project.code} · {sub?.name}</div>
      )}
      {!task.isMilestone && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex-1 h-1 bg-ink-100 rounded">
            <div className="h-full bg-brand-500 rounded" style={{ width: `${task.progress}%` }} />
          </div>
          <span className="text-[10px] font-mono text-ink-500">{task.progress}%</span>
        </div>
      )}
      <div className="mt-1 flex items-center justify-between text-[10px] text-ink-500">
        <span>{task.estimatedEffort}d</span>
        <span className={cn(
          daysToEnd < 0 ? 'text-red-600 font-medium' : daysToEnd <= 3 ? 'text-amber-600' : ''
        )}>
          {format(parseISO(task.plannedEnd), 'MM-dd')}
          {daysToEnd < 0 && ` 逾${-daysToEnd}d`}
        </span>
      </div>
    </button>
  )
}

function KpiCard({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone: 'blue' | 'amber' | 'green' }) {
  const map = {
    blue: { bg: 'bg-brand-50', icon: 'bg-brand-100 text-brand-600', text: 'text-brand-700' },
    amber: { bg: 'bg-amber-50', icon: 'bg-amber-100 text-amber-600', text: 'text-amber-700' },
    green: { bg: 'bg-emerald-50', icon: 'bg-emerald-100 text-emerald-600', text: 'text-emerald-700' },
  }[tone]
  return (
    <div className={cn('card p-4 flex items-center gap-3', map.bg)}>
      <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', map.icon)}>{icon}</div>
      <div>
        <div className={cn('text-2xl font-semibold leading-none', map.text)}>{value}</div>
        <div className="text-xs text-ink-700 mt-1">{label}</div>
      </div>
    </div>
  )
}
