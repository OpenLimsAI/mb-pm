// 推荐负责人（FR-SW-002）：按专业组匹配 + 负荷率升序给出候选人。
// 指定一个真实任务时，参数取自任务本身，可直接改派（写后端），但只能改派给该项目团队中的人；不指定任务则仅作试算。

import { useMemo, useState, type ReactNode } from 'react'
import { X, Sparkles, CheckCircle2, AlertTriangle, ArrowRight, ListChecks, Loader2 } from 'lucide-react'
import { addDays } from 'date-fns'
import { Button, Tag, Avatar } from '../ui'
import { recommendForTask } from '../../lib/workload'
import { modules } from '../../mock/dictionaries'
import { tasks as allTasks, projects, findSubProject, findTask, findUser, TODAY } from '../../mock'
import { updateTaskProgress } from '../../data/bootstrap'
import { asAPIError } from '../../api/client'
import { can } from '../../lib/permissions'
import { getScope, filterTasks } from '../../lib/scope'
import { isTaskDone } from '../../lib/schedule'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import type { Module, Task } from '../../types'
import { cn } from '../../lib/cn'
import { teamIds } from '../../lib/projectTeam'

interface Props {
  /** 预选的任务（如从「过载周任务」进入）；不传则从试算开始 */
  initialTaskId?: string
  onClose: () => void
  /** 改派成功后回调（参数为提示文案） */
  onAssigned: (message: string) => void
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

export function RecommendModal({ initialTaskId, onClose, onAssigned }: Props) {
  const me = useAuth((s) => s.currentUser)
  const version = useDataStore((s) => s.version)
  const canAssign = can(me?.role, 'task.update')

  // 可改派的任务：当前用户可见、未完成、非里程碑，按项目分组
  const groups = useMemo(() => {
    const visible = filterTasks(allTasks, getScope(me)).filter((t) => !t.isMilestone && !isTaskDone(t))
    const byProject = new Map<string, Task[]>()
    for (const t of visible) {
      const pid = findSubProject(t.subProjectId)?.projectId
      if (!pid) continue
      byProject.set(pid, [...(byProject.get(pid) ?? []), t])
    }
    return projects
      .filter((p) => byProject.has(p.id))
      .map((p) => ({ project: p, tasks: byProject.get(p.id)!.sort((a, b) => a.code.localeCompare(b.code)) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, version])

  const [taskId, setTaskId] = useState(initialTaskId ?? '')
  const task = taskId ? findTask(taskId) : undefined
  const taskSub = task ? findSubProject(task.subProjectId) : undefined
  const taskModule = taskSub?.module
  // 指定任务时只能改派给该项目团队中的人
  const taskProject = taskSub ? projects.find((p) => p.id === taskSub.projectId) : undefined
  const team = taskProject ? teamIds(taskProject) : null
  const outsideTeam = (userId: string) => !!team && !team.has(userId)

  // 试算参数（不指定任务时可编辑）
  const [module, setModule] = useState<Module>('分析方法')
  const [effort, setEffort] = useState(8)
  const [start, setStart] = useState(iso(TODAY))
  const [end, setEnd] = useState(iso(addDays(TODAY, 14)))

  const pModule: string | undefined = task ? taskModule : module
  const pEffort = task ? task.estimatedEffort : effort
  const pStart = task ? task.plannedStart : start
  const pEnd = task ? task.plannedEnd : end
  const invalid = !pStart || !pEnd || pEnd < pStart

  const candidates = useMemo(
    () => (invalid ? [] : recommendForTask({ module: pModule, estimatedEffort: pEffort, plannedStart: pStart, plannedEnd: pEnd, task })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pModule, pEffort, pStart, pEnd, invalid, version],
  )
  const eligible = candidates.filter((c) => c.predictedLevel !== 'high' && c.matchesGroup && !outsideTeam(c.user.id))
  const overload = candidates.filter((c) => c.predictedLevel === 'high')

  const [picked, setPicked] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const pickedUser = picked ? findUser(picked) : undefined

  const assign = async () => {
    if (!task || !picked || picked === task.ownerId) return
    setPending(true)
    setError('')
    try {
      await updateTaskProgress(task.id, { ownerId: picked })
      onAssigned(`已将「${task.code} ${task.name}」改派给 ${pickedUser?.displayName ?? picked}`)
    } catch (e) {
      const { status, detail } = asAPIError(e)
      setError(status === 403 ? '当前账号无权改派该任务。' : `改派失败：${detail}`)
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="推荐负责人">
      <div className="absolute inset-0 bg-black/30" onClick={pending ? undefined : onClose} />
      <div className="relative ml-auto w-full max-w-3xl bg-white shadow-2xl flex flex-col">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-ink-300/40">
          <div className="w-9 h-9 rounded-md bg-brand-100 text-brand-600 flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-ink-900">推荐负责人</h2>
            <p className="text-xs text-ink-500">按专业组匹配 + 负荷率从低到高排序（FR-SW-002）</p>
          </div>
          <button onClick={onClose} disabled={pending} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* 任务 / 试算参数 */}
          <div className="px-6 py-4 bg-ink-100/50 border-b border-ink-300/40">
            <h3 className="text-sm font-medium text-ink-900 mb-2 flex items-center gap-1.5">
              <ListChecks className="w-3.5 h-3.5 text-brand-600" />
              任务
            </h3>
            <select
              className="input w-full mb-3"
              value={taskId}
              disabled={pending}
              onChange={(e) => { setTaskId(e.target.value); setPicked(null); setError('') }}
            >
              <option value="">不指定任务（仅试算）</option>
              {groups.map((g) => (
                <optgroup key={g.project.id} label={`${g.project.code} ${g.project.name}`}>
                  {g.tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.code} {t.name}（{findUser(t.ownerId)?.displayName ?? '未分配'}）
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Field label="所属模块">
                <select className="input" value={pModule ?? ''} disabled={!!task} onChange={(e) => setModule(e.target.value as Module)}>
                  {task && !pModule && <option value="">—</option>}
                  {modules.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
              <Field label="预估工时（人天）">
                <input
                  type="number"
                  className="input"
                  value={pEffort}
                  disabled={!!task}
                  onChange={(e) => setEffort(parseFloat(e.target.value || '0') || 0)}
                />
              </Field>
              <Field label="计划开始">
                <input type="date" className="input" value={pStart} disabled={!!task} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="计划结束">
                <input type="date" className="input" value={pEnd} disabled={!!task} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </div>
            {invalid && <p className="text-xs text-red-600 mt-2">计划结束不能早于计划开始。</p>}
          </div>

          <div className="px-6 py-3 flex items-center gap-3 border-b border-ink-300/40 text-sm flex-wrap">
            <Tag tone="green" className="gap-1">
              <CheckCircle2 className="w-3 h-3" />
              {eligible.length} 位符合条件
            </Tag>
            <Tag tone="red" className="gap-1">
              <AlertTriangle className="w-3 h-3" />
              {overload.length} 位接手后将过载
            </Tag>
            <span className="ml-auto text-[11px] text-ink-500">
              符合条件：接手后负荷 ≤ 90% 且专业组匹配{team ? '、在项目团队中' : ''}；按负荷率升序
            </span>
          </div>

          <ul className="divide-y divide-ink-300/40">
            {candidates.map((c) => (
              <CandidateRow
                key={c.user.id}
                c={c}
                isCurrentOwner={c.user.id === task?.ownerId}
                outsideTeam={outsideTeam(c.user.id)}
                picked={picked === c.user.id}
                onPick={() => setPicked(c.user.id)}
              />
            ))}
            {candidates.length === 0 && !invalid && (
              <li className="px-6 py-10 text-center text-sm text-ink-500">暂无可推荐的工艺开发人员</li>
            )}
          </ul>
        </div>

        <div className="px-6 py-3 border-t border-ink-300/40 flex items-center justify-between gap-3">
          <div className="text-xs text-ink-500 min-w-0">
            {error ? (
              <span role="alert" className="text-red-600">{error}</span>
            ) : !task ? (
              '仅试算：在上方指定一个任务后可直接改派。'
            ) : !canAssign ? (
              '当前角色无改派权限，仅可查看推荐。'
            ) : pickedUser ? (
              <>已选中：<span className="font-medium text-ink-900">{pickedUser.displayName}</span></>
            ) : (
              '请选择候选人'
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" onClick={onClose} disabled={pending}>关闭</Button>
            {task && canAssign && (
              <Button
                variant="primary"
                disabled={!picked || picked === task.ownerId || pending}
                onClick={assign}
                icon={pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              >
                {picked === task.ownerId ? '已是当前负责人' : pickedUser ? `改派给 ${pickedUser.displayName}` : '改派'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CandidateRow({
  c, isCurrentOwner, outsideTeam, picked, onPick,
}: { c: ReturnType<typeof recommendForTask>[number]; isCurrentOwner: boolean; outsideTeam: boolean; picked: boolean; onPick: () => void }) {
  const willOverload = c.predictedLevel === 'high'
  const groupMismatch = !c.matchesGroup
  return (
    <li
      className={cn(
        'px-6 py-3 flex items-center gap-3 transition-colors',
        outsideTeam ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        picked ? 'bg-brand-50' : !outsideTeam && 'hover:bg-ink-100/40',
        willOverload && !outsideTeam && 'opacity-70'
      )}
      title={outsideTeam ? '不在该项目团队中，不能改派；请先在项目「团队」页加入' : undefined}
      onClick={outsideTeam ? undefined : onPick}
    >
      <div className={cn(
        'w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center',
        picked ? 'border-brand-600 bg-brand-600' : 'border-ink-300'
      )}>
        {picked && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
      </div>

      <Avatar user={c.user} size="lg" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span className="font-medium text-sm text-ink-900">{c.user.displayName}</span>
          {c.user.specialtyGroup && <Tag tone={groupMismatch ? 'gray' : 'blue'}>{c.user.specialtyGroup}</Tag>}
          {isCurrentOwner && <Tag tone="purple">当前负责人</Tag>}
          {outsideTeam && <Tag tone="gray">不在项目团队</Tag>}
          {groupMismatch && <Tag tone="yellow">非专业组匹配</Tag>}
          {willOverload && <Tag tone="red">接手后将过载</Tag>}
        </div>
        <div className="text-[11px] text-ink-500">当前负责 {c.currentTaskCount} 个未完成任务</div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <RateBlock label="当前" rate={c.currentRate} level={c.currentLevel} />
        <ArrowRight className="w-3 h-3 text-ink-500" />
        <RateBlock label="接手后" rate={c.predictedRate} level={c.predictedLevel} highlighted />
      </div>
    </li>
  )
}

function RateBlock({ label, rate, level, highlighted }: { label: string; rate: number; level: 'low' | 'mid' | 'high'; highlighted?: boolean }) {
  const colorMap = {
    low: 'text-emerald-700 bg-emerald-50',
    mid: 'text-amber-700 bg-amber-50',
    high: 'text-red-700 bg-red-50',
  }
  return (
    <div className={cn('text-center px-2.5 py-1 rounded', highlighted ? colorMap[level] : 'bg-ink-100 text-ink-700')}>
      <div className={cn('text-base font-semibold leading-none font-mono', highlighted ? '' : 'text-ink-900')}>{Number.isFinite(rate) ? `${rate}%` : '无可用容量'}</div>
      <div className="text-[10px] mt-0.5">{label}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink-700 mb-0.5">{label}</label>
      {children}
    </div>
  )
}
