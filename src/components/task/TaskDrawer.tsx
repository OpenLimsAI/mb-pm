import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  X, Calendar, Flame, Diamond, GitBranch, MessageSquare, ChevronRight,
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
import { useAuth } from '../../store/auth'
import { can } from '../../lib/permissions'
import { taskRequestError } from '../../api/taskCollaboration'
import { clearProgressDraft, draftFromTask, loadProgressDraft, progressFingerprint, progressPatch, storeProgressDraft, type ProgressDraft } from './progressDraft'
import { TaskCollaborationPanel } from './TaskCollaborationPanel'
import { ScheduleAssist } from './ScheduleAssist'
import { PMAssistant } from '../project/PMAssistant'

interface Props {
  task: Task | null
  onClose: () => void
}

export function TaskDrawer({ task, onClose }: Props) {
  const [editorDirty, setEditorDirty] = useState(false)
  const currentUser = useAuth(s => s.currentUser)
  const currentUserId = currentUser?.id ?? 'offline'
  const online = useDataStore(s => s.mode) === 'api'
  const requestClose = (event?: { preventDefault: () => void }) => {
    if (editorDirty && !window.confirm('有未保存的进展，确定放弃修改并关闭？')) { event?.preventDefault(); return }
    if (task) clearProgressDraft(currentUserId, task.id)
    onClose()
  }
  // ESC 关闭
  useEffect(() => {
    if (!task) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (!editorDirty || window.confirm('有未保存的进展，确定放弃修改并关闭？')) { clearProgressDraft(currentUserId, task.id); onClose() } } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [task, onClose, editorDirty, currentUserId])

  if (!task) return null

  const owner = findUser(task.ownerId)
  const sub = findSubProject(task.subProjectId)
  const project = sub ? findProject(sub.projectId) : null
  const canAssist = online && (currentUser?.role === 'admin' || currentUser?.role === 'cmc_lead'
    || (currentUser?.role === 'project_lead' && currentUser.id === project?.ownerId))
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
      <div className="absolute inset-0 bg-black/30" onClick={requestClose} />
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
                <Link to={`/projects/${project.id}`} className="hover:text-brand-600" onClick={requestClose}>
                  {project.code} · {project.name}
                </Link>
              )}
              <ChevronRight className="w-3 h-3" />
              <span>{sub?.name}</span>
            </div>
          </div>
          <button
            onClick={requestClose}
            className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 space-y-5">
          {/* 进展录入（核心：可编辑，写入后端并自动汇总到子项目/项目） */}
          <ProgressEditor key={task.id} task={task} onDirtyChange={setEditorDirty} />
          {canAssist && project && <ScheduleAssist key={`${currentUserId}:${project.id}:${task.id}`}
            userId={currentUserId} projectId={project.id} task={task} editorDirty={editorDirty} />}

          {project && <PMAssistant projectId={project.id} taskId={task.id} disabled={editorDirty} />}

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

          <TaskCollaborationPanel key={task.id} task={task} />
        </div>
      </div>
    </div>
  )
}

// ============= 进展录入 =============

function ProgressEditor({ task, onDirtyChange }: { task: Task; onDirtyChange: (dirty: boolean) => void }) {
  const mode = useDataStore((s) => s.mode)
  const user = useAuth((s) => s.currentUser)
  const canPlan = mode === 'mock' || can(user?.role, 'task.update')
  const editable = canPlan || !!user && (task.ownerId === user.id || !!task.collaboratorIds?.includes(user.id))
  const [initial] = useState(() => mode === 'api' ? loadProgressDraft(user?.id ?? 'offline', task, canPlan) : { base: task, draft: draftFromTask(task), restored: false })
  const [base, setBase] = useState(initial.base)
  const [draft, setDraft] = useState(initial.draft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState<Task | null>(() => initial.restored && initial.base.revision !== task.revision ? task : null)
  const [observed, setObserved] = useState(() => progressFingerprint(task))
  const patch = progressPatch(base, draft, canPlan)
  const dirty = Object.keys(patch).length > 0
  useEffect(() => {
    onDirtyChange(dirty)
    if (mode === 'api' && user) { if (dirty) storeProgressDraft(user.id, base, draft); else clearProgressDraft(user.id, task.id) }
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, onDirtyChange, mode, user, base, draft, task.id])
  const source = progressFingerprint(task)
  // A refresh must never silently discard a draft. Only a clean editor follows the source.
  if (source !== observed) {
    setObserved(source)
    if (dirty && !saving) setConflict(task)
    else if (!saving) { setBase(task); setDraft(draftFromTask(task)); setConflict(null) }
  }
  const change = (value: Partial<ProgressDraft>) => { setDraft(d => ({ ...d, ...value })); setSaved(false) }
  const onStatus = (status: TaskStatus) => change({ status, progress: status === '已完成' || status === '已验证' ? 100 : status === '未开始' || task.isMilestone ? 0 : draft.progress })
  const datesInvalid = canPlan && (!draft.plannedStart || !draft.plannedEnd || draft.plannedEnd < draft.plannedStart)
  const actualInvalid = !!draft.actualStart && !!draft.actualEnd && draft.actualEnd < draft.actualStart
  const numberInvalid = [draft.actualEffort, draft.actualCost].some(value => value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0))
  const save = async () => {
    if (!editable || datesInvalid || actualInvalid || numberInvalid || conflict) return
    setSaving(true); setError(null)
    try {
      await updateTaskProgress(task.id, { ...patch, expectedRevision: base.revision })
      const next = { ...base, ...patch, revision: (base.revision ?? 0) + 1 } as Task
      setBase(next); setDraft(draftFromTask(next)); setConflict(null); setSaved(true)
    } catch (failure) {
      const detail = taskRequestError(failure)
      setError(detail.message)
      if (detail.current) setConflict(detail.current)
    } finally { setSaving(false) }
  }
  const serverFields = conflict ? draftFromTask(conflict) : null
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink-900 flex items-center gap-1.5"><PencilLine className="w-4 h-4 text-brand-600" />进展录入</h3>
        {mode === 'mock' && <span className="text-[10px] text-amber-700">离线模式 · 不持久化</span>}
      </div>
      {initial.restored && dirty && <p className="text-xs text-brand-700 mb-3">已恢复本标签页未保存的草稿，保存后才会更新任务。</p>}
      {!editable && <p className="text-xs text-ink-500 mb-3">此任务只读，仅负责人和协作人可录入进展。</p>}
      {conflict && <div role="alert" className="mb-3 rounded bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
        <p>任务已更新，当前草稿已保留。请比较最新数据后选择处理方式。</p><p>草稿基于版本 {base.revision ?? 1}；最新版本 {conflict.revision ?? 1}。</p>
        <table className="w-full text-left"><thead><tr><th>字段</th><th>最新数据</th><th>我的草稿</th></tr></thead><tbody>
          {(['status', 'progress', 'plannedStart', 'plannedEnd', 'actualStart', 'actualEnd', 'actualEffort', 'actualCost'] as const).filter(key => serverFields?.[key] !== draft[key]).map(key => <tr key={key}><td>{({ status: '状态', progress: '进度', plannedStart: '计划开始', plannedEnd: '计划结束', actualStart: '实际开始', actualEnd: '实际结束', actualEffort: '实际工时', actualCost: '实际花费' })[key]}</td><td>{String(serverFields?.[key] ?? '—')}</td><td>{String(draft[key] || '—')}</td></tr>)}
        </tbody></table>
        <div className="flex gap-3"><button className="underline" onClick={() => { setBase(conflict); setDraft(draftFromTask(conflict)); setConflict(null); setError(null) }}>使用最新数据</button><button className="underline" onClick={() => { setBase(conflict); setConflict(null); setError(null) }}>保留草稿，基于最新版本继续</button></div>
      </div>}
      <fieldset disabled={!editable || saving} className="grid grid-cols-2 gap-3">
        <label className="block col-span-2"><span className="text-[11px] text-ink-500">状态</span><select className="input mt-1" value={primaryTaskStatus(draft.status)} onChange={e => onStatus(e.target.value as TaskStatus)}>{PRIMARY_TASK_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        {(draft.status === '阻塞' || draft.status === '延迟') && <div className="col-span-2 flex items-center gap-3 text-xs"><span className="rounded bg-amber-50 px-2 py-1 text-amber-800">副状态：{draft.status}</span><button className="text-brand-700 hover:underline" onClick={() => onStatus('进行中')}>清除副状态</button></div>}
        {!task.isMilestone && <label className="block col-span-2"><span className="text-[11px] text-ink-500">完成进度 <span className="font-medium text-ink-700">{draft.progress}%</span></span><input type="range" min={0} max={100} step={5} value={draft.progress} onChange={e => change({ progress: Number(e.target.value) })} className="w-full mt-2 accent-brand-600" /></label>}
        <label className="block min-w-0"><span className="text-[11px] text-ink-500">计划开始</span><input type="date" className="input mt-1 min-w-0" value={draft.plannedStart} disabled={!canPlan} onChange={e => change({ plannedStart: e.target.value })} /></label>
        <label className="block min-w-0"><span className="text-[11px] text-ink-500">计划结束</span><input type="date" className={cn('input mt-1 min-w-0', datesInvalid && 'border-red-400')} value={draft.plannedEnd} disabled={!canPlan} min={draft.plannedStart || undefined} onChange={e => change({ plannedEnd: e.target.value })} /></label>
        {!canPlan && <p className="col-span-2 text-xs text-ink-500">计划日期由项目负责人维护。</p>}
        <label className="block min-w-0"><span className="text-[11px] text-ink-500">实际开始</span><input type="date" className="input mt-1 min-w-0" value={draft.actualStart} onChange={e => change({ actualStart: e.target.value })} /></label>
        <label className="block min-w-0"><span className="text-[11px] text-ink-500">实际结束</span><input type="date" className="input mt-1 min-w-0" value={draft.actualEnd} onChange={e => change({ actualEnd: e.target.value })} /></label>
        {!task.isMilestone && <label className="block"><span className="text-[11px] text-ink-500">实际工时（人天）</span><input type="number" min={0} step={0.5} className="input mt-1" value={draft.actualEffort} onChange={e => change({ actualEffort: e.target.value })} placeholder={`预估 ${task.estimatedEffort}`} /></label>}
        <label className="block"><span className="text-[11px] text-ink-500">实际花费（万元）</span><input type="number" min={0} step={0.01} className="input mt-1" value={draft.actualCost} onChange={e => change({ actualCost: e.target.value })} placeholder="未填报" /></label>
        <label className="block col-span-2"><span className="text-[11px] text-ink-500">本次进展说明</span><textarea aria-label="本次进展说明" className="input mt-1" maxLength={5000} value={draft.note} onChange={e => change({ note: e.target.value })} placeholder="完成了什么、遇到的问题、下一步安排" /></label>
      </fieldset>
      {(datesInvalid || actualInvalid || numberInvalid) && <p role="alert" className="mt-3 text-xs text-red-600">请检查日期先后顺序，工时和花费须为非负数。</p>}
      {error && <div role="alert" className="mt-3 text-xs text-red-600">{error}</div>}
      <div className="mt-3 flex items-center justify-between gap-3"><span className="text-[11px] text-ink-500">{saved && !dirty ? '✓ 已保存，进度已汇总到子项目与项目' : dirty ? '有未保存修改' : '保存后将自动汇总项目进度与花费'}</span><Button variant="primary" size="sm" icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} disabled={!editable || !dirty || saving || datesInvalid || actualInvalid || numberInvalid || !!conflict} onClick={save}>{saving ? '保存中…' : '保存进展'}</Button></div>
      <div className="mt-3 pt-3 border-t border-brand-200/60 flex items-center gap-2"><span className="text-[11px] text-ink-500">快捷：</span>
        {draft.status !== '进行中' && draft.status !== '已完成' && draft.status !== '已验证' && <button disabled={!editable} className="text-xs text-brand-700 flex items-center gap-1" onClick={() => change({ status: '进行中', progress: task.isMilestone ? 0 : draft.progress, actualStart: draft.actualStart || new Date().toLocaleDateString('sv-SE') })}><Clock className="w-3 h-3" />开始</button>}
        {draft.status !== '已完成' && draft.status !== '已验证' && <button disabled={!editable} className="text-xs text-emerald-700 flex items-center gap-1" onClick={() => change({ status: '已完成', progress: 100, actualEnd: draft.actualEnd || new Date().toLocaleDateString('sv-SE') })}><CheckCircle2 className="w-3 h-3" />标记完成</button>}
        {!task.isMilestone && draft.status !== '阻塞' && <button disabled={!editable} className="text-xs text-amber-700 flex items-center gap-1" onClick={() => onStatus('阻塞')}><AlertTriangle className="w-3 h-3" />标记阻塞</button>}
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
