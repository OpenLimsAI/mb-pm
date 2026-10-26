// 全局任务（FR-TK-003）：跨项目筛选（关键路径 / 里程碑 / 已逾期）+ 批量改状态 / 改负责人（写入后端）。
// 数据范围按角色自动收窄：执行者（rd / production / qa_qc）只看、只改自己的任务。

import { useMemo, useState } from 'react'
import { Search, X, CheckSquare, Square, Diamond, Flame, UserCog, RefreshCw, Eye, Loader2, ListChecks } from 'lucide-react'
import {
  tasks as allTasks, projects as allProjects, subProjects, users, findProject, findSubProject, findUser, findTask, TODAY,
} from '../mock'
import { taskStatuses, priorities } from '../mock/dictionaries'
import type { Task, TaskStatus, Priority } from '../types'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import { updateTasksBatch, type TaskProgressPatch } from '../data/bootstrap'
import { can } from '../lib/permissions'
import { getScope, filterProjects, filterTasks, scopeLabel } from '../lib/scope'
import { isTaskDone } from '../lib/schedule'
import { sortTasksByProjectWbsOrder } from '../lib/taskOrder'
import { Button, Card, Tag, StatusTag, PriorityTag, Avatar, EmptyState } from '../components/ui'
import { TaskDrawer } from '../components/task/TaskDrawer'
import { cn } from '../lib/cn'

interface Filters {
  keyword: string
  projectId: string | 'all'
  status: TaskStatus | 'all'
  priority: Priority | 'all'
  ownerId: string | 'all' | 'me'
  scope: 'all' | 'critical' | 'milestone' | 'overdue'
}

const initialFilters: Filters = {
  keyword: '',
  projectId: 'all',
  status: 'all',
  priority: 'all',
  ownerId: 'all',
  scope: 'all',
}

const todayStr = TODAY.toISOString().slice(0, 10)
const isOverdue = (t: Task) => !isTaskDone(t) && t.plannedEnd < todayStr

export default function Tasks() {
  const me = useAuth((s) => s.currentUser)
  const version = useDataStore((s) => s.version)

  const userScope = useMemo(() => getScope(me), [me])
  const isOwnTaskOnly = userScope.isOwnTaskOnly
  const canBatchStatus = can(me?.role, 'task.update') || can(me?.role, 'task.update.own')
  const canBatchOwner = can(me?.role, 'task.update')

  // 运行时数组在数据同步时原地替换内容：每个数据版本取一份新数组，下游 useMemo 才会随之重算
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleProjects = useMemo(() => [...filterProjects(allProjects, userScope)], [userScope, version])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleTasks = useMemo(() => sortTasksByProjectWbsOrder(filterTasks(allTasks, userScope), visibleProjects, subProjects), [userScope, visibleProjects, version])
  const owners = useMemo(() => {
    const ids = new Set(visibleTasks.map((t) => t.ownerId))
    return users.filter((u) => ids.has(u.id)).sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'))
  }, [visibleTasks])

  const [filters, setFilters] = useState<Filters>(() => ({ ...initialFilters, ownerId: isOwnTaskOnly ? 'me' : 'all' }))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const filtered = useMemo(() => {
    const k = filters.keyword.trim().toLowerCase()
    return visibleTasks.filter((t) => {
      if (k && !`${t.code} ${t.name}`.toLowerCase().includes(k)) return false
      const sub = subProjects.find((s) => s.id === t.subProjectId)
      if (!sub) return false
      if (filters.projectId !== 'all' && sub.projectId !== filters.projectId) return false
      if (filters.status !== 'all' && t.status !== filters.status) return false
      if (filters.priority !== 'all' && t.priority !== filters.priority) return false
      if (filters.ownerId === 'me') { if (t.ownerId !== me?.id) return false }
      else if (filters.ownerId !== 'all' && t.ownerId !== filters.ownerId) return false
      if (filters.scope === 'critical' && !t.isCriticalPath) return false
      if (filters.scope === 'milestone' && !t.isMilestone) return false
      if (filters.scope === 'overdue' && !isOverdue(t)) return false
      return true
    })
  }, [filters, me, visibleTasks])

  // 选中集合只保留当前筛选结果中的任务，避免批量操作误伤看不见的行
  const selectedIds = filtered.filter((t) => selected.has(t.id)).map((t) => t.id)
  const allChecked = filtered.length > 0 && selectedIds.length === filtered.length

  const toggle = (id: string) => {
    const n = new Set(selected)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setSelected(n)
  }
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(filtered.map((t) => t.id)))

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
          <ListChecks className="w-6 h-6 text-brand-600" />
          任务
        </h1>
        <p className="text-sm text-ink-500 mt-1">
          {userScope.isAll ? '全部项目' : '可见范围内'}的任务 · 可见 <span className="font-medium">{visibleTasks.length}</span> 个，
          匹配 <span className="font-medium text-brand-600">{filtered.length}</span> 个
          {isOwnTaskOnly && '（仅显示我负责的任务）'}
          {' · 按项目结构排序'}
        </p>
      </div>

      {!userScope.isAll && (
        <div className="mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-2">
          <Eye className="w-3.5 h-3.5" />
          数据范围：<span className="font-medium">{scopeLabel(userScope)}</span>
          <span className="text-amber-600">（按 IAM 角色自动过滤）</span>
        </div>
      )}

      {/* 筛选条 */}
      <Card className="p-3 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
            <input
              value={filters.keyword}
              onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
              placeholder="搜索任务编号、名称…"
              className="w-full pl-8 pr-3 py-1.5 rounded-md bg-ink-100 text-sm border border-transparent focus:outline-none focus:bg-white focus:border-brand-500"
            />
          </div>
          <Sel
            label="项目"
            value={filters.projectId}
            onChange={(v) => setFilters({ ...filters, projectId: v })}
            opts={[{ v: 'all', l: '全部' }, ...visibleProjects.map((p) => ({ v: p.id, l: `${p.code} - ${p.name}` }))]}
          />
          <Sel
            label="状态"
            value={filters.status}
            onChange={(v) => setFilters({ ...filters, status: v as TaskStatus | 'all' })}
            opts={[{ v: 'all', l: '全部' }, ...taskStatuses.map((s) => ({ v: s, l: s }))]}
          />
          <Sel
            label="优先级"
            value={filters.priority}
            onChange={(v) => setFilters({ ...filters, priority: v as Priority | 'all' })}
            opts={[{ v: 'all', l: '全部' }, ...priorities.map((p) => ({ v: p, l: p }))]}
          />
          {isOwnTaskOnly ? (
            <span className="inline-flex items-center gap-1.5 text-xs rounded-md px-2 py-1 border border-brand-500 bg-brand-50 text-brand-700">
              负责人：仅本人
            </span>
          ) : (
            <Sel
              label="负责人"
              value={filters.ownerId}
              onChange={(v) => setFilters({ ...filters, ownerId: v })}
              opts={[{ v: 'all', l: '全部' }, { v: 'me', l: '我的任务' }, ...owners.map((u) => ({ v: u.id, l: u.displayName }))]}
            />
          )}
          <Sel
            label="范围"
            value={filters.scope}
            onChange={(v) => setFilters({ ...filters, scope: v as Filters['scope'] })}
            opts={[
              { v: 'all', l: '全部' },
              { v: 'critical', l: '仅关键路径' },
              { v: 'milestone', l: '仅里程碑' },
              { v: 'overdue', l: '已逾期' },
            ]}
          />
          <button
            onClick={() => { setFilters({ ...initialFilters, ownerId: isOwnTaskOnly ? 'me' : 'all' }); setSelected(new Set()) }}
            className="ml-auto inline-flex items-center gap-1 text-xs text-ink-700 hover:text-ink-900 px-2 py-1.5 rounded hover:bg-ink-100"
          >
            <RefreshCw className="w-3 h-3" /> 重置
          </button>
        </div>
      </Card>

      {selectedIds.length > 0 && canBatchStatus && (
        <BatchBar
          taskIds={selectedIds}
          canChangeOwner={canBatchOwner}
          owners={users.filter((u) => u.isActive)}
          onCancel={() => setSelected(new Set())}
          onFinished={(result, allSucceeded) => {
            setNotice(result)
            if (allSucceeded) setSelected(new Set())
          }}
        />
      )}

      {notice && (
        <div
          role="status"
          className={cn(
            'mb-3 px-3 py-2 rounded-md border text-xs flex items-center gap-2',
            notice.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
          )}
        >
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭提示" className="p-0.5 rounded hover:bg-black/5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <Card><EmptyState title="没有匹配的任务" description="试试调整筛选条件" /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-100 text-xs text-ink-700">
                <tr>
                  <th className="w-10 px-3 py-2">
                    {canBatchStatus && (
                      <button onClick={toggleAll} className="flex items-center justify-center w-full" aria-label="全选">
                        {allChecked ? <CheckSquare className="w-4 h-4 text-brand-600" /> : <Square className="w-4 h-4 text-ink-500" />}
                      </button>
                    )}
                  </th>
                  <th className="px-3 py-2 text-left">任务</th>
                  <th className="px-3 py-2 text-left">项目 / 子项目</th>
                  <th className="px-3 py-2 text-left">负责人</th>
                  <th className="px-3 py-2 text-left">状态</th>
                  <th className="px-3 py-2 text-left">优先级</th>
                  <th className="px-3 py-2 text-right">工时</th>
                  <th className="px-3 py-2 text-left">计划结束</th>
                  <th className="px-3 py-2 text-left w-32">进度</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    selectable={canBatchStatus}
                    selected={selected.has(t.id)}
                    onToggle={() => toggle(t.id)}
                    onOpen={() => setOpenTaskId(t.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <TaskDrawer task={openTaskId ? findTask(openTaskId) || null : null} onClose={() => setOpenTaskId(null)} />
    </div>
  )
}

interface Notice {
  tone: 'ok' | 'error'
  text: string
}

// 批量操作条：改状态（管理者 / 执行者本人任务）、改负责人（仅管理者），逐条写后端并汇总结果。
function BatchBar({
  taskIds, canChangeOwner, owners, onCancel, onFinished,
}: {
  taskIds: string[]
  canChangeOwner: boolean
  owners: { id: string; displayName: string }[]
  onCancel: () => void
  onFinished: (result: Notice, allSucceeded: boolean) => void
}) {
  const [status, setStatus] = useState<TaskStatus | ''>('')
  const [ownerId, setOwnerId] = useState('')
  const [pending, setPending] = useState(false)

  const run = async (patch: TaskProgressPatch, describe: (n: number) => string) => {
    setPending(true)
    try {
      const { updated, failed } = await updateTasksBatch(taskIds, patch)
      if (failed.length === 0) {
        onFinished({ tone: 'ok', text: describe(updated) }, true)
      } else {
        onFinished({ tone: 'error', text: `${updated} 个成功，${failed.length} 个失败（仍保持选中）：${failed[0].detail}` }, false)
      }
    } catch {
      onFinished({ tone: 'error', text: '保存失败，请刷新页面后确认结果。' }, false)
    } finally {
      setPending(false)
    }
  }

  const applyStatus = () => {
    if (!status) return
    const patch: TaskProgressPatch = { status }
    // 与 WBS 行内编辑一致：完成 → 100%，未开始 → 0%
    if (status === '已完成' || status === '已验证') patch.progress = 100
    else if (status === '未开始') patch.progress = 0
    void run(patch, (n) => `已将 ${n} 个任务的状态改为「${status}」`)
  }

  return (
    <div className="bg-brand-50 border border-brand-300 rounded-md px-4 py-2.5 mb-3 flex flex-wrap items-center gap-3">
      <CheckSquare className="w-4 h-4 text-brand-700" />
      <span className="text-sm text-brand-900 font-medium">已选中 {taskIds.length} 个任务</span>
      <span className="text-ink-300">|</span>
      <label className="inline-flex items-center gap-1.5 text-xs">
        <span className="text-ink-700">状态改为</span>
        <select className="input py-1 text-xs" value={status} disabled={pending} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
          <option value="">选择…</option>
          {taskStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <Button size="sm" variant="secondary" disabled={!status || pending} onClick={applyStatus} icon={<RefreshCw className="w-3.5 h-3.5" />}>
        批量改状态
      </Button>
      {canChangeOwner && (
        <>
          <label className="inline-flex items-center gap-1.5 text-xs">
            <span className="text-ink-700">负责人改为</span>
            <select className="input py-1 text-xs" value={ownerId} disabled={pending} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">选择…</option>
              {owners.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={!ownerId || pending}
            onClick={() => {
              const name = owners.find((u) => u.id === ownerId)?.displayName ?? ''
              void run({ ownerId }, (n) => `已将 ${n} 个任务改派给 ${name}`)
            }}
            icon={<UserCog className="w-3.5 h-3.5" />}
          >
            批量改负责人
          </Button>
        </>
      )}
      {pending && <span className="inline-flex items-center gap-1 text-xs text-ink-700"><Loader2 className="w-3.5 h-3.5 animate-spin" />正在保存…</span>}
      <Button variant="ghost" size="sm" className="ml-auto" disabled={pending} onClick={onCancel} icon={<X className="w-3.5 h-3.5" />}>
        取消选中
      </Button>
    </div>
  )
}

function TaskRow({
  task, selectable, selected, onToggle, onOpen,
}: { task: Task; selectable: boolean; selected: boolean; onToggle: () => void; onOpen: () => void }) {
  const sub = findSubProject(task.subProjectId)
  const project = sub ? findProject(sub.projectId) : null
  const owner = findUser(task.ownerId)
  const overdue = isOverdue(task)

  return (
    <tr
      className={cn('border-b border-ink-300/40 hover:bg-ink-100/40 cursor-pointer', selected && 'bg-brand-50')}
      onClick={onOpen}
    >
      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        {selectable && (
          <button onClick={onToggle} className="flex items-center justify-center w-full" aria-label={`选择 ${task.code}`}>
            {selected ? <CheckSquare className="w-4 h-4 text-brand-600" /> : <Square className="w-4 h-4 text-ink-500" />}
          </button>
        )}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-ink-500">{task.code}</span>
          {task.isMilestone && <Diamond className="w-3 h-3 text-amber-600" />}
          {task.isCriticalPath && <Flame className="w-3 h-3 text-red-500" />}
        </div>
        <div className={cn('text-sm mt-0.5 text-ink-900', task.isMilestone && 'font-semibold')}>{task.name}</div>
      </td>
      <td className="px-3 py-2.5">
        <div className="text-xs text-ink-700 truncate max-w-[200px]" title={project?.name}>{project?.code}</div>
        <div className="text-[11px] text-ink-500 truncate max-w-[200px]" title={sub?.name}>{sub?.name}</div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          {owner && <Avatar user={owner} size="sm" />}
          <span className="text-xs">{owner?.displayName}</span>
        </div>
      </td>
      <td className="px-3 py-2.5"><StatusTag status={task.status} /></td>
      <td className="px-3 py-2.5"><PriorityTag priority={task.priority} /></td>
      <td className="px-3 py-2.5 text-right text-xs font-mono">{task.isMilestone ? '—' : `${task.estimatedEffort}d`}</td>
      <td className="px-3 py-2.5 text-xs whitespace-nowrap">
        <span className={cn('font-mono', overdue && 'text-red-600 font-medium')}>{task.plannedEnd}</span>
        {overdue && <Tag tone="red" className="ml-1">逾期</Tag>}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-ink-100 rounded">
            <div
              className={cn(
                'h-full rounded',
                isTaskDone(task) ? 'bg-emerald-500' :
                task.status === '延迟' || task.status === '阻塞' ? 'bg-amber-500' : 'bg-brand-500'
              )}
              style={{ width: `${task.progress}%` }}
            />
          </div>
          <span className="text-[11px] font-mono w-8 text-right">{task.progress}%</span>
        </div>
      </td>
    </tr>
  )
}

function Sel({
  label, value, onChange, opts,
}: { label: string; value: string; onChange: (v: string) => void; opts: { v: string; l: string }[] }) {
  const isAll = value === 'all'
  return (
    <label className={cn(
      'inline-flex items-center gap-1.5 text-xs rounded-md px-2 py-1 border transition-colors',
      isAll ? 'border-ink-300 bg-white' : 'border-brand-500 bg-brand-50'
    )}>
      <span className="text-ink-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-ink-900 text-xs focus:outline-none cursor-pointer max-w-[200px]"
      >
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  )
}
