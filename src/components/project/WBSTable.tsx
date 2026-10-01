// 可批量录入的 WBS 表格视图 —— 取代「逐个任务打开抽屉编辑」的主工作面。
//
// 设计目标（对应 CTO 反馈 #1 / #4）：
//   · 上百乃至上千个任务时，进展录入要快 —— 状态 / 进度 / 计划起止 / 实际结束 全部行内编辑、即时保存。
//   · 计划开始 / 结束在哪里输入？—— 就在表格行内，所见即所得。
//   · 规模化交互：顶部工具条提供 搜索 + 状态/负责人筛选 + 快捷过滤（仅里程碑 / 仅逾期延迟 / 仅未完成），
//     按子项目分组折叠，把「找到要改的任务」这件事变简单。
//
// 行内任一字段改动 → 调 updateTaskProgress（API：PATCH + 自动汇总到子项目/项目；离线：本地汇总），
// 每行带独立的保存状态指示（保存中 / 已保存 / 失败）。任务名仍可点开抽屉看依赖、备注等完整信息。

import { useMemo, useState } from 'react'
import {
  Search, Diamond, Flame, ChevronDown, ChevronRight, Check, Loader2, AlertCircle,
  FolderTree, Filter, X,
} from 'lucide-react'
import type { Project, SubProject, Task, TaskStatus, User } from '../../types'
import { Card, CardBody, Avatar } from '../ui'
import { getProjectSubs, getSubTasks, findUser, users, TODAY } from '../../mock'
import { updateTaskProgress, type TaskProgressPatch } from '../../data/bootstrap'
import { useDataStore } from '../../store/data'
import { useAuth } from '../../store/auth'
import { can } from '../../lib/permissions'
import { getTaskSchedule, isTaskDone, scheduleToneText } from '../../lib/schedule'
import { cn } from '../../lib/cn'

const TASK_STATUSES: TaskStatus[] = ['未开始', '进行中', '阻塞', '延迟', '已完成', '已验证']
const MILESTONE_STATUSES: TaskStatus[] = ['未开始', '已验证']

const STATUS_DOT: Record<TaskStatus, string> = {
  未开始: 'bg-ink-300',
  进行中: 'bg-brand-500',
  阻塞: 'bg-red-500',
  延迟: 'bg-amber-500',
  已完成: 'bg-emerald-500',
  已验证: 'bg-emerald-600',
}

type QuickFilter = 'all' | 'milestone' | 'risk' | 'open'

interface Props {
  project: Project
  onOpenTask?: (taskId: string) => void
  selectedTaskId?: string
}

export function WBSTable({ project, onOpenTask, selectedTaskId }: Props) {
  // 订阅数据版本：任一行保存后重新汇总并刷新本表
  useDataStore((s) => s.version)

  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all')
  const [ownerFilter, setOwnerFilter] = useState<string>('all')
  const [quick, setQuick] = useState<QuickFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // 运行时数组会原地更新；每次数据版本刷新后重新读取，避免缓存旧子项目或负责人。
  const subs = getProjectSubs(project.id).sort((a, b) => a.sortOrder - b.sortOrder)
  const ownerIds = new Set(subs.flatMap((s) => getSubTasks(s.id).map((t) => t.ownerId)))
  const ownerOptions = users.filter((u) => ownerIds.has(u.id))

  // 可改派的负责人：在职用户，项目团队（负责人 + 成员）优先分组，便于行内改派
  const teamIds = useMemo(
    () => new Set<string>([project.ownerId, ...(project.memberIds || [])]),
    [project.ownerId, project.memberIds],
  )
  const active = users.filter((u) => u.isActive !== false)
  const byName = (a: User, b: User) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
  const team = active.filter((u) => teamIds.has(u.id)).sort(byName)
  const others = active.filter((u) => !teamIds.has(u.id)).sort(byName)

  const matches = (t: Task): boolean => {
    const kw = keyword.trim().toLowerCase()
    if (kw) {
      const owner = findUser(t.ownerId)
      const hay = `${t.code} ${t.name} ${owner?.displayName ?? ''}`.toLowerCase()
      if (!hay.includes(kw)) return false
    }
    if (statusFilter !== 'all' && t.status !== statusFilter) return false
    if (ownerFilter !== 'all' && t.ownerId !== ownerFilter) return false
    if (quick === 'milestone' && !t.isMilestone) return false
    if (quick === 'open' && isTaskDone(t)) return false
    if (quick === 'risk') {
      const sch = getTaskSchedule(t, TODAY)
      const risky = sch.state === 'overdue' || t.status === '延迟' || t.status === '阻塞'
      if (!risky) return false
    }
    return true
  }

  // 分组：子项目 → 命中的任务
  const groups = subs
    .map((sub) => ({ sub, tasks: getSubTasks(sub.id).filter(matches) }))
    .filter((g) => g.tasks.length > 0)

  const totalShown = groups.reduce((a, g) => a + g.tasks.length, 0)
  const totalAll = subs.reduce((a, s) => a + getSubTasks(s.id).length, 0)
  const hasFilter = keyword.trim() !== '' || statusFilter !== 'all' || ownerFilter !== 'all' || quick !== 'all'

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const resetFilters = () => {
    setKeyword('')
    setStatusFilter('all')
    setOwnerFilter('all')
    setQuick('all')
  }

  return (
    <Card>
      {/* 工具条 */}
      <div className="px-4 py-3 border-b border-ink-300/40 space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
            <FolderTree className="w-4 h-4 text-brand-600" /> WBS 任务清单
          </span>
          <span className="text-xs text-ink-500">
            {hasFilter ? <>匹配 <b className="text-brand-600">{totalShown}</b> / {totalAll}</> : <>共 {totalAll} 个任务</>}
          </span>
          <div className="flex-1" />
          {/* 搜索 */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-ink-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索任务 / 编号 / 负责人"
              className="h-8 w-56 pl-8 pr-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none"
            />
          </div>
          {/* 状态筛选 */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as TaskStatus | 'all')}
            className="h-8 px-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none"
          >
            <option value="all">全部状态</option>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {/* 负责人筛选 */}
          <select
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            className="h-8 px-2 text-sm rounded-md border border-ink-300 bg-white focus:border-brand-400 focus:outline-none max-w-[140px]"
          >
            <option value="all">全部负责人</option>
            {ownerOptions.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </div>

        {/* 快捷过滤 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3 h-3 text-ink-400" />
          <QuickChip active={quick === 'all'} onClick={() => setQuick('all')}>全部</QuickChip>
          <QuickChip active={quick === 'open'} onClick={() => setQuick('open')}>未完成</QuickChip>
          <QuickChip active={quick === 'risk'} onClick={() => setQuick('risk')} tone="red">逾期 / 延迟 / 阻塞</QuickChip>
          <QuickChip active={quick === 'milestone'} onClick={() => setQuick('milestone')} tone="amber">仅里程碑</QuickChip>
          {hasFilter && (
            <button onClick={resetFilters} className="ml-1 text-xs text-ink-500 hover:text-ink-800 flex items-center gap-0.5">
              <X className="w-3 h-3" /> 清除
            </button>
          )}
          <span className="ml-auto text-[11px] text-ink-400">行内可直接编辑 · 改动即时保存并汇总</span>
        </div>
      </div>

      <CardBody className="p-0 overflow-x-auto">
        {totalShown === 0 ? (
          <div className="py-12 text-center text-sm text-ink-500">没有匹配的任务，试试调整筛选条件。</div>
        ) : (
          <table className="w-full text-sm border-collapse min-w-[1090px]">
            <thead>
              <tr className="text-[11px] text-ink-500 bg-ink-100/60 border-b border-ink-300/50">
                <th className="text-left font-medium px-3 py-2 w-[30%]">任务</th>
                <th className="text-left font-medium px-2 py-2 w-[100px]">负责人</th>
                <th className="text-left font-medium px-2 py-2 w-[110px]">状态</th>
                <th className="text-left font-medium px-2 py-2 w-[120px]">进度</th>
                <th className="text-right font-medium px-2 py-2 w-[80px]">预算(万)</th>
                <th className="text-right font-medium px-2 py-2 w-[80px]">花费(万)</th>
                <th className="text-left font-medium px-2 py-2 w-[124px]">计划开始</th>
                <th className="text-left font-medium px-2 py-2 w-[170px]">计划结束</th>
                <th className="text-left font-medium px-2 py-2 w-[124px]">实际结束</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(({ sub, tasks }) => (
                <SubGroup
                  key={sub.id}
                  sub={sub}
                  tasks={tasks}
                  collapsed={collapsed.has(sub.id)}
                  onToggle={() => toggle(sub.id)}
                  onOpenTask={onOpenTask}
                  selectedTaskId={selectedTaskId}
                  team={team}
                  others={others}
                />
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  )
}

function SubGroup({ sub, tasks, collapsed, onToggle, onOpenTask, selectedTaskId, team, others }: {
  sub: SubProject
  tasks: Task[]
  collapsed: boolean
  onToggle: () => void
  onOpenTask?: (id: string) => void
  selectedTaskId?: string
  team: User[]
  others: User[]
}) {
  const subBudget = tasks.reduce((a, t) => a + (t.costBudget ?? 0), 0)
  const subCost = tasks.reduce((a, t) => a + (t.actualCost ?? 0), 0)
  return (
    <>
      <tr className="bg-purple-50/50 border-b border-ink-300/40 cursor-pointer hover:bg-purple-50" onClick={onToggle}>
        <td colSpan={9} className="px-3 py-1.5">
          <div className="flex items-center gap-2">
            {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-ink-500" /> : <ChevronDown className="w-3.5 h-3.5 text-ink-500" />}
            <span className="tag bg-purple-100 text-purple-800 font-mono text-[10px]">Lv2</span>
            <span className="text-sm font-medium text-ink-900">{sub.name}</span>
            <span className="text-[11px] text-ink-500">{sub.stage} · {sub.module}</span>
            <span className="text-[11px] text-ink-400">{tasks.length} 项</span>
            {subBudget > 0 && (
              <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-px">
                预算 {Math.round(subBudget).toLocaleString('zh-CN')} 万
              </span>
            )}
            {subCost > 0 && (
              <span className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-px">
                花费 {Math.round(subCost).toLocaleString('zh-CN')} 万
              </span>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 w-32">
              <div className="flex-1 h-1.5 bg-ink-200 rounded">
                <div className="h-full bg-brand-500 rounded" style={{ width: `${sub.progress}%` }} />
              </div>
              <span className="text-[10px] text-ink-500 w-8 text-right">{sub.progress}%</span>
            </div>
          </div>
        </td>
      </tr>
      {!collapsed && tasks.map((t) => (
        <WBSRow key={t.id} task={t} onOpenTask={onOpenTask} selected={selectedTaskId === t.id} team={team} others={others} />
      ))}
    </>
  )
}

type RowState = 'idle' | 'saving' | 'saved' | 'error'

function WBSRow({ task, onOpenTask, selected, team, others }: {
  task: Task
  onOpenTask?: (id: string) => void
  selected?: boolean
  team: User[]
  others: User[]
}) {
  const owner = findUser(task.ownerId)
  const ownerInList = team.some((u) => u.id === task.ownerId) || others.some((u) => u.id === task.ownerId)
  // 任务预算只由项目负责人及以上维护；执行层只录入实际花费（后端同样拦截）
  const canEditBudget = can(useAuth((s) => s.currentUser?.role), 'task.budget.edit')
  const isMilestone = task.isMilestone
  const schedule = getTaskSchedule(task, TODAY)
  const [rowState, setRowState] = useState<RowState>('idle')
  // 进度本地草稿（数字输入需要在 blur/Enter 时才提交）
  const [progressDraft, setProgressDraft] = useState<string>(String(task.progress))
  // 预算本地草稿（万元；空串=未设置）
  const [budgetDraft, setBudgetDraft] = useState<string>(task.costBudget != null ? String(task.costBudget) : '')
  // 实际花费本地草稿（万元；空串=未录入）
  const [costDraft, setCostDraft] = useState<string>(task.actualCost != null ? String(task.actualCost) : '')

  // 提交一个或多个字段；保存成功后由全局 version bump 触发刷新
  const commit = async (patch: TaskProgressPatch) => {
    setRowState('saving')
    try {
      await updateTaskProgress(task.id, patch)
      setRowState('saved')
      window.setTimeout(() => setRowState((s) => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (e) {
      console.error(e)
      setRowState('error')
    }
  }

  const onStatusChange = (next: TaskStatus) => {
    const patch: TaskProgressPatch = { status: next }
    // 与抽屉一致：完成→100%、未开始→0%
    if (next === '已完成' || next === '已验证') patch.progress = 100
    else if (next === '未开始') patch.progress = 0
    commit(patch)
  }

  const commitProgress = () => {
    let v = Math.round(Number(progressDraft))
    if (Number.isNaN(v)) { setProgressDraft(String(task.progress)); return }
    v = Math.max(0, Math.min(100, v))
    setProgressDraft(String(v))
    if (v === task.progress) return
    const patch: TaskProgressPatch = { progress: v }
    if (v === 100 && !isTaskDone(task)) patch.status = '已完成'
    commit(patch)
  }

  const onOwnerChange = (id: string) => { if (id && id !== task.ownerId) commit({ ownerId: id }) }

  const commitBudget = () => {
    const raw = budgetDraft.trim()
    if (raw === '') {
      if (task.costBudget != null) commit({ costBudget: null })
      return
    }
    let v = Number(raw)
    if (Number.isNaN(v) || v < 0) { setBudgetDraft(task.costBudget != null ? String(task.costBudget) : ''); return }
    v = Math.round(v * 100) / 100
    setBudgetDraft(String(v))
    if (v === (task.costBudget ?? null)) return
    commit({ costBudget: v })
  }

  const commitCost = () => {
    const raw = costDraft.trim()
    if (raw === '') {
      if (task.actualCost != null) commit({ actualCost: null })
      return
    }
    let v = Number(raw)
    if (Number.isNaN(v) || v < 0) { setCostDraft(task.actualCost != null ? String(task.actualCost) : ''); return }
    v = Math.round(v * 100) / 100
    setCostDraft(String(v))
    if (v === (task.actualCost ?? null)) return
    commit({ actualCost: v })
  }

  const onPlannedStart = (v: string) => { if (v && v !== task.plannedStart) commit({ plannedStart: v }) }
  const onPlannedEnd = (v: string) => {
    if (!v || v === task.plannedEnd) return
    if (v < task.plannedStart) { setRowState('error'); return }
    commit({ plannedEnd: v })
  }
  const onActualEnd = (v: string) => {
    const norm = v || null
    if (norm !== (task.actualEnd ?? null)) commit({ actualEnd: norm })
  }

  return (
    <tr className={cn(
      'border-b border-ink-200/60 hover:bg-brand-50/30',
      selected && 'bg-brand-50/60',
    )}>
      {/* 任务名（点击打开抽屉看完整信息） */}
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isMilestone
            ? <Diamond className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            : <span className="tag bg-emerald-100 text-emerald-800 font-mono text-[9px] shrink-0">L3</span>}
          <span className="font-mono text-[10px] text-ink-400 shrink-0">{task.code}</span>
          <button
            onClick={() => onOpenTask?.(task.id)}
            className={cn('truncate text-left hover:text-brand-700 hover:underline', isMilestone && 'font-semibold')}
            title="点击查看完整详情（依赖 / 备注 / 交付物）"
          >
            {task.name}
          </button>
          {task.isCriticalPath && <Flame className="w-3 h-3 text-red-500 shrink-0" aria-label="关键路径" />}
          <RowIndicator state={rowState} />
        </div>
      </td>

      {/* 负责人（行内可改派） */}
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {owner && <Avatar user={owner} size="sm" />}
          <select
            value={task.ownerId}
            onChange={(e) => onOwnerChange(e.target.value)}
            title="点击改派负责人"
            className="h-7 w-[76px] px-1 text-xs text-ink-700 rounded border border-transparent hover:border-ink-300 bg-transparent focus:border-brand-400 focus:bg-white focus:outline-none cursor-pointer truncate"
          >
            {!ownerInList && <option value={task.ownerId}>{owner?.displayName ?? '（未知负责人）'}</option>}
            <optgroup label="项目团队">
              {team.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </optgroup>
            {others.length > 0 && (
              <optgroup label="其他成员">
                {others.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      </td>

      {/* 状态（行内下拉，即时保存） */}
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[task.status])} />
          <select
            value={task.status}
            onChange={(e) => onStatusChange(e.target.value as TaskStatus)}
            className="h-7 w-[84px] px-1 text-xs rounded border border-transparent hover:border-ink-300 bg-transparent focus:border-brand-400 focus:bg-white focus:outline-none cursor-pointer"
          >
            {(isMilestone ? MILESTONE_STATUSES : TASK_STATUSES).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </td>

      {/* 进度（里程碑不适用） */}
      <td className="px-2 py-1.5">
        {isMilestone ? (
          <span className="text-xs text-ink-400">—</span>
        ) : (
          <div className="flex items-center gap-1.5">
            <div className="flex-1 h-1.5 bg-ink-200 rounded min-w-[40px]">
              <div
                className={cn('h-full rounded', isTaskDone(task) ? 'bg-emerald-500' : task.status === '阻塞' || task.status === '延迟' ? 'bg-amber-500' : 'bg-brand-500')}
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <input
              type="number" min={0} max={100} step={5}
              value={progressDraft}
              onChange={(e) => setProgressDraft(e.target.value)}
              onBlur={commitProgress}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="h-7 w-12 px-1 text-xs text-right rounded border border-transparent hover:border-ink-300 focus:border-brand-400 focus:bg-white focus:outline-none tabular-nums"
            />
            <span className="text-[10px] text-ink-400">%</span>
          </div>
        )}
      </td>

      {/* 预算（万元；项目负责人及以上行内可改，空=未设置；执行层只读） */}
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-0.5">
          {canEditBudget ? (
            <input
              type="number" min={0} step={5}
              value={budgetDraft}
              placeholder="—"
              onChange={(e) => setBudgetDraft(e.target.value)}
              onBlur={commitBudget}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="h-7 w-16 px-1 text-xs text-right rounded border border-transparent hover:border-ink-300 focus:border-brand-400 focus:bg-white focus:outline-none tabular-nums placeholder:text-ink-300"
              title="成本预算（万元）"
            />
          ) : (
            <span className="h-7 w-16 px-1 text-xs text-right tabular-nums text-ink-600 leading-7" title="任务预算由项目负责人及以上维护">
              {task.costBudget ?? <span className="text-ink-300">—</span>}
            </span>
          )}
        </div>
      </td>

      {/* 实际花费（万元，行内可改；超预算标红） */}
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-0.5">
          <input
            type="number" min={0} step={5}
            value={costDraft}
            placeholder="—"
            onChange={(e) => setCostDraft(e.target.value)}
            onBlur={commitCost}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className={cn(
              'h-7 w-16 px-1 text-xs text-right rounded border border-transparent hover:border-ink-300 focus:border-brand-400 focus:bg-white focus:outline-none tabular-nums placeholder:text-ink-300',
              task.actualCost != null && task.costBudget != null && task.actualCost > task.costBudget && 'text-red-600 font-medium',
            )}
            title={task.actualCost != null && task.costBudget != null && task.actualCost > task.costBudget ? '已超预算' : '实际花费（万元）'}
          />
        </div>
      </td>

      {/* 计划开始 */}
      <td className="px-2 py-1.5">
        <DateCell value={task.plannedStart} onCommit={onPlannedStart} />
      </td>

      {/* 计划结束 + 排期徽标 */}
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <DateCell value={task.plannedEnd} min={task.plannedStart} onCommit={onPlannedEnd} />
          <span className={cn('text-[10px] whitespace-nowrap', scheduleToneText[schedule.tone])} title={schedule.label}>
            {scheduleBadge(schedule)}
          </span>
        </div>
      </td>

      {/* 实际结束 */}
      <td className="px-2 py-1.5">
        <DateCell value={task.actualEnd ?? ''} onCommit={onActualEnd} />
      </td>
    </tr>
  )
}

/** 行内日期单元格：与单元格融为一体，聚焦时才显边框。
 *  `key={value}`（在调用处由 WBSRow 的 task 标识隐式保证刷新）+ defaultValue 让保存刷新后回到最新值。 */
function DateCell({ value, min, onCommit }: {
  value: string
  min?: string
  onCommit: (v: string) => void
}) {
  return (
    <input
      key={value}
      type="date"
      defaultValue={value}
      min={min || undefined}
      onChange={(e) => onCommit(e.target.value)}
      className={cn(
        'h-7 w-[108px] px-1 text-xs rounded border border-transparent hover:border-ink-300 focus:border-brand-400 focus:bg-white focus:outline-none font-mono',
        !value && 'text-ink-400',
      )}
    />
  )
}

/** 排期徽标的简短形态（表格内空间有限）。 */
function scheduleBadge(s: ReturnType<typeof getTaskSchedule>): string {
  switch (s.state) {
    case 'done-ontime': return '✓ 按时'
    case 'done-late': return `延期${s.days}d`
    case 'overdue': return `逾期${-s.days}d`
    case 'due-today': return '今日'
    case 'due-soon': return `剩${s.days}d`
    default: return `${s.days}d`
  }
}

function RowIndicator({ state }: { state: RowState }) {
  if (state === 'saving') return <Loader2 className="w-3 h-3 text-brand-500 animate-spin shrink-0" aria-label="保存中" />
  if (state === 'saved') return <Check className="w-3 h-3 text-emerald-500 shrink-0" aria-label="已保存" />
  if (state === 'error') return <AlertCircle className="w-3 h-3 text-red-500 shrink-0" aria-label="保存失败" />
  return null
}

function QuickChip({ active, tone = 'brand', onClick, children }: {
  active: boolean
  tone?: 'brand' | 'red' | 'amber'
  onClick: () => void
  children: React.ReactNode
}) {
  const tones = {
    brand: active ? 'bg-brand-600 text-white border-brand-600' : 'text-ink-600 border-ink-300 hover:bg-ink-100',
    red: active ? 'bg-red-600 text-white border-red-600' : 'text-red-600 border-red-200 hover:bg-red-50',
    amber: active ? 'bg-amber-500 text-white border-amber-500' : 'text-amber-700 border-amber-200 hover:bg-amber-50',
  }
  return (
    <button
      onClick={onClick}
      className={cn('h-6 px-2 text-xs rounded-full border transition-colors', tones[tone])}
    >
      {children}
    </button>
  )
}
