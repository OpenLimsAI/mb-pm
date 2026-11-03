import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  X, Calendar, Flame, Diamond, GitBranch, MessageSquare, Paperclip, ChevronRight,
  CheckCircle2, AlertTriangle, Clock, Tag as TagIcon, Hash, Save, Loader2, PencilLine,
} from 'lucide-react'
import type { Task, TaskStatus, DependencyType } from '../../types'
import { findUser, findSubProject, findProject, findTask, taskDependencies, TODAY } from '../../mock'
import { Button, Tag, StatusTag, PriorityTag, Avatar } from '../ui'
import { TaskStatusFlow } from './TaskStatusFlow'
import { updateTaskProgress } from '../../data/bootstrap'
import { useDataStore } from '../../store/data'
import { getTaskSchedule, scheduleToneText } from '../../lib/schedule'
import { cn } from '../../lib/cn'
import { PRIMARY_TASK_STATUSES, primaryTaskStatus } from '../../lib/taskStatus'

interface Props {
  task: Task | null
  onClose: () => void
}

export function TaskDrawer({ task, onClose }: Props) {
  // ESC 关闭
  useEffect(() => {
    if (!task) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [task, onClose])

  if (!task) return null

  const owner = findUser(task.ownerId)
  const sub = findSubProject(task.subProjectId)
  const project = sub ? findProject(sub.projectId) : null
  const collaborators = task.collaboratorIds?.map(findUser).filter(Boolean) || []

  // 统一排程口径：已完成任务按「实际 vs 计划」判定，不再误报「逾期」。
  const schedule = getTaskSchedule(task, TODAY)

  const preds = taskDependencies
    .filter((d) => d.successorId === task.id)
    .map((d) => ({ dep: d, task: findTask(d.predecessorId) }))
    .filter((x) => x.task)
  const succs = taskDependencies
    .filter((d) => d.predecessorId === task.id)
    .map((d) => ({ dep: d, task: findTask(d.successorId) }))
    .filter((x) => x.task)

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-[640px] bg-white shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white z-10">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[11px] text-ink-500">{task.code}</span>
              <StatusTag status={task.status} />
              <PriorityTag priority={task.priority} />
              {task.isMilestone && <Tag tone="yellow" className="gap-1"><Diamond className="w-3 h-3" />里程碑</Tag>}
              {task.isCriticalPath && <Tag tone="red" className="gap-1"><Flame className="w-3 h-3" />关键路径</Tag>}
            </div>
            <h2 className="text-lg font-semibold text-ink-900">{task.name}</h2>
            <div className="text-xs text-ink-500 mt-1 flex items-center gap-1">
              {project && (
                <Link to={`/projects/${project.id}`} className="hover:text-brand-600" onClick={onClose}>
                  {project.code} · {project.name}
                </Link>
              )}
              <ChevronRight className="w-3 h-3" />
              <span>{sub?.name}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 space-y-5">
          {/* 进展录入（核心：可编辑，写入后端并自动汇总到子项目/项目） */}
          <ProgressEditor key={task.id} task={task} />

          {/* 状态流转 */}
          <Section title="状态流转" icon={<GitBranch className="w-3.5 h-3.5" />}>
            <TaskStatusFlow current={task.status} />
          </Section>

          {/* 关键时间 */}
          <Section title="时间与工时" icon={<Calendar className="w-3.5 h-3.5" />}>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="计划开始">
                <span className="font-mono">{task.plannedStart}</span>
              </Field>
              <Field label="计划结束">
                <span className="font-mono">{task.plannedEnd}</span>
                <span className={cn('ml-2 text-xs', scheduleToneText[schedule.tone])}>
                  {schedule.label}
                </span>
              </Field>
              <Field label="实际开始">
                <span className="font-mono">{task.actualStart || '—'}</span>
              </Field>
              <Field label="实际结束">
                <span className="font-mono">{task.actualEnd || '—'}</span>
              </Field>
              {!task.isMilestone && (
                <>
                  <Field label="预估工时">
                    <span className="font-mono">{task.estimatedEffort} 人天</span>
                  </Field>
                  <Field label="实际工时">
                    <span className="font-mono">
                      {task.actualEffort ? `${task.actualEffort} 人天` : '—'}
                      {task.actualEffort && task.actualEffort > task.estimatedEffort && (
                        <span className="ml-1 text-red-600">(+{(task.actualEffort - task.estimatedEffort).toFixed(1)})</span>
                      )}
                    </span>
                  </Field>
                </>
              )}
            </div>

            {!task.isMilestone && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-ink-500">完成进度</span>
                  <span className="font-medium">{task.progress}%</span>
                </div>
                <div className="h-2 bg-ink-100 rounded">
                  <div
                    className={cn(
                      'h-full rounded',
                      task.status === '已完成' || task.status === '已验证' ? 'bg-emerald-500' :
                      task.status === '延迟' || task.status === '阻塞' ? 'bg-amber-500' : 'bg-brand-500'
                    )}
                    style={{ width: `${task.progress}%` }}
                  />
                </div>
              </div>
            )}
          </Section>

          {/* 人员 */}
          <Section title="人员" icon={<Hash className="w-3.5 h-3.5" />}>
            <div className="space-y-2">
              <Field label="负责人">
                {owner && (
                  <div className="flex items-center gap-2">
                    <Avatar user={owner} size="sm" />
                    <span className="text-sm font-medium">{owner.displayName}</span>
                    {owner.specialtyGroup && <Tag tone="gray">{owner.specialtyGroup}</Tag>}
                  </div>
                )}
              </Field>
              {collaborators.length > 0 && (
                <Field label="协作人">
                  <div className="flex flex-wrap items-center gap-2">
                    {collaborators.map((u) => u && (
                      <div key={u.id} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-ink-100 text-xs">
                        <Avatar user={u} size="sm" />
                        <span>{u.displayName}</span>
                      </div>
                    ))}
                  </div>
                </Field>
              )}
            </div>
          </Section>

          {/* 依赖关系 */}
          {(preds.length > 0 || succs.length > 0) && (
            <Section title="依赖关系" icon={<GitBranch className="w-3.5 h-3.5" />}>
              {preds.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs text-ink-500 mb-1.5">前置任务（{preds.length}）</div>
                  <ul className="space-y-1">
                    {preds.map(({ dep, task: t }) => t && (
                      <DepRow key={dep.id} task={t} type={dep.type} lag={dep.lagDays} />
                    ))}
                  </ul>
                </div>
              )}
              {succs.length > 0 && (
                <div>
                  <div className="text-xs text-ink-500 mb-1.5">后续任务（{succs.length}）</div>
                  <ul className="space-y-1">
                    {succs.map(({ dep, task: t }) => t && (
                      <DepRow key={dep.id} task={t} type={dep.type} lag={dep.lagDays} />
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          )}

          {/* 备注 */}
          {task.notes && (
            <Section title="备注 / 操作要点" icon={<MessageSquare className="w-3.5 h-3.5" />}>
              <div className="text-sm text-ink-700 p-3 rounded-md bg-ink-100 whitespace-pre-wrap">{task.notes}</div>
            </Section>
          )}

          {/* 标签 */}
          {task.tags && task.tags.length > 0 && (
            <Section title="标签" icon={<TagIcon className="w-3.5 h-3.5" />}>
              <div className="flex flex-wrap gap-1">
                {task.tags.map((t) => <Tag key={t} tone="purple">{t}</Tag>)}
              </div>
            </Section>
          )}

          {/* 交付物（占位） */}
          <Section title="交付物" icon={<Paperclip className="w-3.5 h-3.5" />}>
            <div className="text-xs text-ink-500 italic p-3 rounded-md bg-ink-100/60 border border-dashed border-ink-300">
              暂无交付物。后续支持上传文件 / 链接（占位演示）
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}

// ============= 进展录入 =============

function ProgressEditor({ task }: { task: Task }) {
  const mode = useDataStore((s) => s.mode)
  const isMilestone = task.isMilestone

  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [progress, setProgress] = useState<number>(task.progress)
  const [plannedStart, setPlannedStart] = useState<string>(task.plannedStart)
  const [plannedEnd, setPlannedEnd] = useState<string>(task.plannedEnd)
  const [actualStart, setActualStart] = useState<string>(task.actualStart ?? '')
  const [actualEnd, setActualEnd] = useState<string>(task.actualEnd ?? '')
  const [actualEffort, setActualEffort] = useState<string>(task.actualEffort != null ? String(task.actualEffort) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // 比较字段快照以兼容原地更新；无关刷新保留草稿，有新任务数据时在渲染前同步。
  const source = JSON.stringify([
    task.status, task.progress, task.plannedStart, task.plannedEnd,
    task.actualStart, task.actualEnd, task.actualEffort,
  ])
  const [previousSource, setPreviousSource] = useState(source)
  if (source !== previousSource) {
    setPreviousSource(source)
    setStatus(task.status)
    setProgress(task.progress)
    setPlannedStart(task.plannedStart)
    setPlannedEnd(task.plannedEnd)
    setActualStart(task.actualStart ?? '')
    setActualEnd(task.actualEnd ?? '')
    setActualEffort(task.actualEffort != null ? String(task.actualEffort) : '')
    setSaved(false)
    setError(null)
  }

  const onStatus = (s: TaskStatus) => {
    setStatus(s)
    if (s === '已完成' || s === '已验证') setProgress(100)
    else if (s === '未开始' || isMilestone) setProgress(0)
  }

  const effortNum = actualEffort === '' ? null : Number(actualEffort)
  const datesInvalid = !plannedStart || !plannedEnd || plannedEnd < plannedStart
  const dirty =
    status !== task.status ||
    progress !== task.progress ||
    plannedStart !== task.plannedStart ||
    plannedEnd !== task.plannedEnd ||
    (actualStart || null) !== (task.actualStart ?? null) ||
    (actualEnd || null) !== (task.actualEnd ?? null) ||
    effortNum !== (task.actualEffort ?? null)

  const save = async () => {
    if (datesInvalid) {
      setError('计划结束不能早于计划开始。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await updateTaskProgress(task.id, {
        status,
        progress,
        plannedStart,
        plannedEnd,
        actualStart: actualStart || null,
        actualEnd: actualEnd || null,
        actualEffort: effortNum,
      })
      setSaved(true)
    } catch (e) {
      console.error(e)
      setError('保存失败，请确认后端已启动后重试。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink-900 flex items-center gap-1.5">
          <PencilLine className="w-4 h-4 text-brand-600" /> 进展录入
        </h3>
        {mode === 'mock' && (
          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
            离线模式 · 不持久化
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* 状态 */}
        <label className="block col-span-2">
          <span className="text-[11px] text-ink-500">状态</span>
          <select className="input mt-1" value={primaryTaskStatus(status)} onChange={(e) => onStatus(e.target.value as TaskStatus)}>
            {PRIMARY_TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {(status === '阻塞' || status === '延迟') && (
          <div className="col-span-2 flex items-center gap-3 text-xs">
            <span className="rounded bg-amber-50 px-2 py-1 text-amber-800">副状态：{status}</span>
            <button className="text-brand-700 hover:underline" onClick={() => onStatus('进行中')}>清除副状态</button>
          </div>
        )}

        {/* 进度（里程碑不显示） */}
        {!isMilestone && (
          <label className="block col-span-2">
            <span className="text-[11px] text-ink-500">完成进度 <span className="font-medium text-ink-700">{progress}%</span></span>
            <input
              type="range" min={0} max={100} step={5} value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              className="w-full mt-2 accent-brand-600"
            />
          </label>
        )}

        {/* 计划开始 / 结束（可编辑：排期调整） */}
        <label className="block min-w-0">
          <span className="text-[11px] text-ink-500">计划开始</span>
          <input type="date" className="input mt-1 min-w-0" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} />
        </label>
        <label className="block min-w-0">
          <span className="text-[11px] text-ink-500">计划结束</span>
          <input
            type="date"
            className={cn('input mt-1 min-w-0', datesInvalid && 'border-red-400 focus:border-red-500')}
            value={plannedEnd}
            min={plannedStart || undefined}
            onChange={(e) => setPlannedEnd(e.target.value)}
          />
        </label>

        {/* 实际开始 / 结束 */}
        <label className="block min-w-0">
          <span className="text-[11px] text-ink-500">实际开始</span>
          <input type="date" className="input mt-1 min-w-0" value={actualStart} onChange={(e) => setActualStart(e.target.value)} />
        </label>
        <label className="block min-w-0">
          <span className="text-[11px] text-ink-500">实际结束</span>
          <input type="date" className="input mt-1 min-w-0" value={actualEnd} onChange={(e) => setActualEnd(e.target.value)} />
        </label>

        {/* 实际工时（里程碑不显示） */}
        {!isMilestone && (
          <label className="block">
            <span className="text-[11px] text-ink-500">实际工时（人天）</span>
            <input
              type="number" min={0} step={0.5} className="input mt-1"
              value={actualEffort} onChange={(e) => setActualEffort(e.target.value)}
              placeholder={`预估 ${task.estimatedEffort}`}
            />
          </label>
        )}
      </div>

      {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-ink-500">
          {saved && !dirty ? '✓ 已保存，进度已汇总到子项目与项目' : '保存后将自动重算子项目与项目进度'}
        </span>
        <Button
          variant="primary" size="sm"
          icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          disabled={!dirty || saving || datesInvalid}
          onClick={save}
        >
          {saving ? '保存中…' : '保存进展'}
        </Button>
      </div>

      {/* 快捷操作 */}
      <div className="mt-3 pt-3 border-t border-brand-200/60 flex items-center gap-2">
        <span className="text-[11px] text-ink-500">快捷：</span>
        {status !== '进行中' && status !== '已完成' && status !== '已验证' && (
          <button className="text-xs text-brand-700 hover:underline flex items-center gap-1"
            onClick={() => { onStatus('进行中'); if (!actualStart) setActualStart(TODAY.toISOString().slice(0, 10)) }}>
            <Clock className="w-3 h-3" /> 开始
          </button>
        )}
        {status !== '已完成' && status !== '已验证' && (
          <button className="text-xs text-emerald-700 hover:underline flex items-center gap-1"
            onClick={() => { onStatus('已完成'); if (!actualEnd) setActualEnd(TODAY.toISOString().slice(0, 10)) }}>
            <CheckCircle2 className="w-3 h-3" /> 标记完成
          </button>
        )}
        {!isMilestone && status !== '阻塞' && (
          <button className="text-xs text-amber-700 hover:underline flex items-center gap-1"
            onClick={() => onStatus('阻塞')}>
            <AlertTriangle className="w-3 h-3" /> 标记阻塞
          </button>
        )}
      </div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-ink-500">{label}</div>
      <div className="text-sm text-ink-900 mt-0.5">{children}</div>
    </div>
  )
}

const depTypeLabel: Record<DependencyType, string> = {
  FS: '完成→开始 (FS)',
  SS: '开始→开始 (SS)',
  FF: '完成→完成 (FF)',
  SF: '开始→完成 (SF)',
}

function DepRow({ task, type, lag }: { task: Task; type: DependencyType; lag: number }) {
  return (
    <li className="flex items-center gap-2 px-2 py-1.5 rounded bg-ink-100/60 text-xs">
      <span className="font-mono text-[10px] text-ink-500">{task.code}</span>
      <span className="min-w-0 flex-1 truncate" title={task.name}>{task.name}</span>
      <Tag tone="gray">{depTypeLabel[type]}</Tag>
      {lag !== 0 && <Tag tone={lag > 0 ? ('yellow' as const) : 'gray'}>{lag > 0 ? `+${lag}d` : `${lag}d`}</Tag>}
      <StatusTag status={task.status} />
    </li>
  )
}
