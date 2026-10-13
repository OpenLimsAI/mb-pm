// 项目「编辑模式」—— 与模板结构编辑同一套界面和用法（共用 structure/StructureEditorKit）：
// 增删改子项目、任务 / 里程碑、前置依赖，先记在草稿里，点「保存修改」一次性提交（后端一个事务）。
//
// 只改结构；状态、进度、实际日期与实际花费仍在任务详情或「表格录入」里填写。
// 已开始或已录实际花费的任务不能删除；改日期不自动顺延后续任务，与前置冲突时行内提示。

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Info, Loader2, PencilLine, Plus, RotateCcw } from 'lucide-react'
import axios from 'axios'
import type { Project, User } from '../../types'
import { Button, Card, CardBody, EmptyState, StatusTag } from '../ui'
import { TODAY, users } from '../../mock'
import { getStructure, saveStructure, type StructureSaveResult } from '../../api/structure'
import { refreshAllData } from '../../data/bootstrap'
import { useDataStore } from '../../store/data'
import {
  AddSubButton, AddSubForm, EditorDrawer, PredecessorPicker, SaveBar, StructureCounts, SubCard, TaskRow,
} from '../structure/StructureEditorKit'
import * as S from '../../lib/projectStructure'
import { cn } from '../../lib/cn'

type EditorState = { mode: 'create'; subKey: string } | { mode: 'edit'; subKey: string; task: S.DraftTask }

function errorText(error: unknown): { status?: number; text: string } {
  if (axios.isAxiosError(error)) {
    const detail = (error.response?.data as { detail?: unknown } | undefined)?.detail
    if (typeof detail === 'string') return { status: error.response?.status, text: detail }
    if (Array.isArray(detail) && detail.length) {
      const msg = (detail[0] as { msg?: unknown })?.msg
      return { status: error.response?.status, text: typeof msg === 'string' ? msg.replace(/^Value error, /, '') : '提交的内容无效' }
    }
    if (!error.response) return { text: '无法连接服务器，请稍后重试。' }
  }
  return { text: '操作失败，请稍后重试。' }
}

/** 保存成功后的提示，如「项目结构已保存：新增 2 个任务、删除 1 个任务。」 */
function savedMessage(r: StructureSaveResult): string {
  const parts = [
    r.createdSubProjects && `新增 ${r.createdSubProjects} 个子项目`,
    r.deletedSubProjects && `删除 ${r.deletedSubProjects} 个子项目`,
    r.createdTasks && `新增 ${r.createdTasks} 个任务`,
    r.updatedTasks && `修改 ${r.updatedTasks} 个任务`,
    r.deletedTasks && `删除 ${r.deletedTasks} 个任务`,
    (r.addedDependencies || r.removedDependencies) && `依赖 +${r.addedDependencies} / −${r.removedDependencies}`,
  ].filter(Boolean)
  return parts.length ? `项目结构已保存：${parts.join('、')}。` : '项目结构已保存。'
}

const DISCARD = '放弃未保存的结构修改？'

/** onExit(message)：保存成功时带提示文字；取消 / 返回时为空。 */
export function ProjectStructureEditor({ project, onExit }: { project: Project; onExit: (message?: string) => void }) {
  const online = useDataStore((s) => s.mode) === 'api'
  const [initial, setInitial] = useState<S.ProjectDraft | null>(null)
  const [draft, setDraft] = useState<S.ProjectDraft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [addingSub, setAddingSub] = useState(false)
  const [summary, setSummary] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (!online) return
    let active = true
    getStructure(project.id)
      .then((snap) => {
        if (!active) return
        const d = S.fromSnapshot(snap)
        setInitial(d)
        setDraft(d)
        setLoadError('')
        setSaveError('')
        setStale(false)
      })
      .catch((e) => { if (active) setLoadError(errorText(e).text) })
    return () => { active = false }
  }, [project.id, online, reload])

  const dirty = !!draft && !!initial && !S.sameStructure(draft, initial)

  // 有未保存修改时：刷新 / 关闭页面、点侧边栏等站内链接前先确认（BrowserRouter 不支持 useBlocker）
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    const guardLinks = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = (event.target as Element | null)?.closest?.('a[href]')
      if (!link || link.getAttribute('target') === '_blank') return
      if (!window.confirm(DISCARD)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', guardLinks, true)
    return () => {
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('click', guardLinks, true)
    }
  }, [dirty])

  const conflicts = useMemo(() => (draft ? S.dateConflicts(draft) : new Map<string, string>()), [draft])
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [])
  const codeOf = useMemo(() => new Map(draft ? S.allTasks(draft).map(({ task }) => [task.key, task.code]) : []), [draft])

  const cancel = () => {
    if (dirty && !window.confirm(DISCARD)) return
    onExit()
  }

  const save = async () => {
    if (!draft) return
    const problem = S.draftProblem(draft)
    if (problem) { setSaveError(problem); return }
    setSaving(true)
    setSaveError('')
    let message: string
    try {
      message = savedMessage((await saveStructure(project.id, S.toSaveRequest(draft, summary))).result)
    } catch (e) {
      const { status, text } = errorText(e)
      if (status === 409 && text.includes('已被他人修改')) setStale(true)
      setSaveError(text)
      setSaving(false)
      return
    }
    // 已保存成功；页面数据刷新失败不能再报「保存失败」（否则重试会撞上版本冲突）
    try {
      await refreshAllData()
    } catch {
      message += '页面数据刷新失败，请手动刷新页面查看最新结构。'
    }
    onExit(message)
  }

  if (!online) {
    return (
      <Card>
        <EmptyState
          title="离线演示模式不支持修改项目结构"
          description="连接后端并使用 IAM 登录后，可在编辑模式中增删改任务。"
          action={<Button onClick={() => onExit()}>返回</Button>}
        />
      </Card>
    )
  }
  if (loadError) {
    return (
      <Card>
        <CardBody className="flex items-center gap-3 text-sm">
          <AlertTriangle className="w-4 h-4 text-red-600" />
          <span className="text-red-700 flex-1">读取项目结构失败：{loadError}</span>
          <Button size="sm" onClick={() => setReload((v) => v + 1)}>重试</Button>
          <Button size="sm" variant="ghost" onClick={() => onExit()}>返回</Button>
        </CardBody>
      </Card>
    )
  }
  if (!draft) {
    return <div className="py-12 text-center text-sm text-ink-500 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />正在读取项目结构…</div>
  }

  const counts = S.counts(draft)
  return (
    <div className="pb-24">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900 flex items-center gap-2">
            <PencilLine className="w-5 h-5 text-brand-600" /> 编辑项目结构
          </h2>
          <p className="text-sm text-ink-500 mt-1">
            修改先保存在草稿里，点「保存修改」后一次性生效。状态、进度、实际日期与实际花费请在任务详情或「表格录入」中填写。
          </p>
        </div>
        <StructureCounts {...counts} />
      </div>

      {stale && (
        <div role="alert" className="mb-3 p-3 rounded-lg bg-amber-50 text-amber-800 text-sm flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">编辑期间有人修改了这个项目的结构，本次修改未保存。重新载入会放弃本次修改。</span>
          <Button size="sm" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => setReload((v) => v + 1)}>重新载入</Button>
        </div>
      )}

      <div className="space-y-3">
        {draft.subs.length === 0 && !addingSub && (
          <Card>
            <EmptyState
              title="还没有子项目"
              description="项目由「子项目（Lv2）→ 任务（Lv3）」组成。先添加一个子项目，再往里加任务。"
              action={<Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setAddingSub(true)}>添加子项目</Button>}
            />
          </Card>
        )}

        {draft.subs.map((sub) => (
          <SubCard
            key={sub.key}
            value={{ name: sub.name, module: sub.module, stage: sub.stage }}
            taskCount={sub.tasks.length}
            onChange={(f) => setDraft((d) => (d ? S.updateSub(d, sub.key, f) : d))}
            onDelete={() => setDraft((d) => (d ? S.deleteSub(d, sub.key) : d))}
            deleteBlockedReason={S.subDeleteBlocked(sub)}
            onAddTask={() => setEditor({ mode: 'create', subKey: sub.key })}
          >
            {sub.tasks.map((t) => (
              <TaskRow
                key={t.key}
                code={t.code}
                name={t.name}
                isMilestone={t.isMilestone}
                tag={userById.get(t.ownerId)?.displayName ?? null}
                durationDays={S.durationDays(t.plannedStart, t.plannedEnd)}
                effort={t.estimatedEffort}
                predecessorCodes={t.predecessors.map((k) => codeOf.get(k) ?? k)}
                warning={conflicts.get(t.key)}
                extra={t.status !== '未开始' ? <StatusTag status={t.status} /> : t.id === null ? <span className="text-[10px] text-brand-700 bg-brand-50 border border-brand-200 rounded px-1">新增</span> : null}
                deleteBlockedReason={t.lockedReason}
                codeClassName="w-28"
                onEdit={() => setEditor({ mode: 'edit', subKey: sub.key, task: t })}
                onDelete={() => setDraft((d) => (d ? S.deleteTask(d, t.key) : d))}
              />
            ))}
          </SubCard>
        ))}

        {addingSub ? (
          <Card><CardBody><AddSubForm requireModuleStage onCancel={() => setAddingSub(false)} onSubmit={(f) => { setDraft((d) => (d ? S.addSub(d, f) : d)); setAddingSub(false) }} /></CardBody></Card>
        ) : draft.subs.length > 0 && <AddSubButton onClick={() => setAddingSub(true)} />}
      </div>

      <SaveBar
        summary={summary}
        onSummary={setSummary}
        error={saveError || undefined}
        saving={saving}
        saveLabel="保存修改"
        saveDisabled={!dirty || stale}
        onCancel={cancel}
        onSave={save}
      >
        <span className={cn('text-xs shrink-0', dirty ? 'text-amber-700' : 'text-ink-400')}>{dirty ? '有未保存的修改' : '尚未修改'}</span>
      </SaveBar>

      {editor && (
        <ProjectTaskDrawer
          key={editor.mode === 'edit' ? editor.task.key : `create-${editor.subKey}`}
          draft={draft}
          state={editor}
          project={project}
          onClose={() => setEditor(null)}
          onSubmit={(input) => {
            setDraft((d) => {
              if (!d) return d
              return editor.mode === 'create' ? S.addTask(d, editor.subKey, input) : S.updateTask(d, editor.task.key, input)
            })
            setEditor(null)
          }}
        />
      )}
    </div>
  )
}

// ============= 任务表单（与模板的任务抽屉同一外观） =============

function ownerOptions(project: Project, currentOwnerId?: string): User[] {
  const team = new Set([project.ownerId, ...(project.memberIds ?? [])])
  return users
    .filter((u) => u.isActive || u.id === currentOwnerId)
    .sort((a, b) => Number(team.has(b.id)) - Number(team.has(a.id)) || a.displayName.localeCompare(b.displayName, 'zh'))
}

function ProjectTaskDrawer({ draft, state, project, onClose, onSubmit }: {
  draft: S.ProjectDraft
  state: EditorState
  project: Project
  onClose: () => void
  onSubmit: (input: S.TaskInput) => void
}) {
  const editing = state.mode === 'edit' ? state.task : null
  const today = TODAY.toISOString().slice(0, 10)
  const defaultStart = draft.projectStart > today ? draft.projectStart : today
  const [f, setF] = useState<S.TaskInput>(() => editing
    ? {
        name: editing.name, isMilestone: editing.isMilestone, ownerId: editing.ownerId,
        plannedStart: editing.plannedStart, plannedEnd: editing.plannedEnd, estimatedEffort: editing.estimatedEffort,
        costBudget: editing.costBudget, notes: editing.notes, predecessors: editing.predecessors,
      }
    : {
        name: '', isMilestone: false, ownerId: draft.ownerId, plannedStart: defaultStart, plannedEnd: S.addDays(defaultStart, 14),
        estimatedEffort: 2, costBudget: null, notes: '', predecessors: [],
      })
  const set = (patch: Partial<S.TaskInput>) => setF((prev) => ({ ...prev, ...patch }))
  const duration = S.durationDays(f.plannedStart, f.plannedEnd)
  const latest = S.latestPredecessorEnd(draft, f.predecessors)
  const conflict = latest && latest > f.plannedStart ? latest : null
  const valid = f.name.trim().length > 0 && !!f.ownerId && /^\d{4}-\d{2}-\d{2}$/.test(f.plannedStart)
  const owners = ownerOptions(project, editing?.ownerId)
  const subName = new Map(draft.subs.flatMap((s) => s.tasks.map((t) => [t.key, s.name])))
  const candidates = S.allTasks(draft)
    .filter(({ task }) => task.key !== editing?.key)
    .map(({ task }) => ({
      id: task.key,
      code: task.code,
      name: task.name,
      subName: subName.get(task.key),
      disabledReason: editing && S.wouldCycle(draft, editing.key, task.key) ? '会形成循环依赖' : null,
    }))
  const toggle = (key: string) =>
    set({ predecessors: f.predecessors.includes(key) ? f.predecessors.filter((k) => k !== key) : [...f.predecessors, key] })

  return (
    <EditorDrawer
      title={editing ? '编辑任务' : '新建任务'}
      code={editing?.code ?? S.nextTaskCode(draft, state.subKey)}
      onClose={onClose}
      onSubmit={() => onSubmit({
        ...f,
        name: f.name.trim(),
        plannedEnd: f.isMilestone ? f.plannedStart : f.plannedEnd,
        // 新建的里程碑、或由普通任务改成里程碑时不带工时；已有里程碑的工时保持不变
        estimatedEffort: f.isMilestone && !editing?.isMilestone ? 0 : f.estimatedEffort,
      })}
      submitLabel={editing ? '保存' : '添加任务'}
      submitDisabled={!valid}
    >
      {editing && editing.status !== '未开始' && (
        <p className="text-xs rounded-md bg-ink-100/70 text-ink-700 p-2.5 flex gap-1.5">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          该任务已开始（{editing.status} · {editing.progress}%），不能删除。状态、进度、实际日期请在任务详情或「表格录入」中修改。
        </p>
      )}
      <label className="block">
        <span className="text-[11px] text-ink-500">任务名称 <span className="text-red-500">*</span></span>
        <input autoFocus className={cn('input mt-1', !f.name.trim() && 'border-red-300')} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="如：宿主细胞蛋白(HCP)方法开发" maxLength={200} />
      </label>

      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={f.isMilestone} onChange={(e) => set({ isMilestone: e.target.checked })} className="accent-brand-600" />
        里程碑（时间点，无工期 / 工时）
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-ink-500">负责人 <span className="text-red-500">*</span></span>
          <select className="input mt-1" value={f.ownerId} onChange={(e) => set({ ownerId: e.target.value })}>
            {owners.map((u) => (
              <option key={u.id} value={u.id}>{u.displayName}{u.specialtyGroup ? ` · ${u.specialtyGroup}` : ''}{u.isActive ? '' : '（已停用）'}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-500">成本预算（万）</span>
          <input type="number" min={0} className="input mt-1" value={f.costBudget ?? ''} onChange={(e) => set({ costBudget: e.target.value === '' ? null : Number(e.target.value) })} placeholder="可选" />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-500">{f.isMilestone ? '日期' : '计划开始'}</span>
          <input type="date" className="input mt-1" value={f.plannedStart} onChange={(e) => e.target.value && set({ plannedStart: e.target.value, plannedEnd: S.addDays(e.target.value, duration) })} />
        </label>
        {!f.isMilestone && (
          <label className="block">
            <span className="text-[11px] text-ink-500">工期（天）</span>
            <input type="number" min={0} className="input mt-1" value={duration} onChange={(e) => set({ plannedEnd: S.addDays(f.plannedStart, Math.max(0, Number(e.target.value) || 0)) })} />
          </label>
        )}
        {!f.isMilestone && (
          <>
            <div className="block">
              <span className="text-[11px] text-ink-500">计划结束</span>
              <div className="mt-1 h-[34px] flex items-center text-sm text-ink-700 tabular-nums">{f.plannedEnd}</div>
            </div>
            <label className="block">
              <span className="text-[11px] text-ink-500">工时（人天）</span>
              <input type="number" min={0} step={0.5} className="input mt-1" value={f.estimatedEffort} onChange={(e) => set({ estimatedEffort: e.target.value === '' ? 0 : Number(e.target.value) })} />
            </label>
          </>
        )}
      </div>

      {conflict && (
        <p className="text-xs text-red-600 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          开始日期早于前置任务的结束（{conflict}）。
          <button type="button" className="text-brand-700 underline" onClick={() => set({ plannedStart: conflict, plannedEnd: S.addDays(conflict, duration) })}>改为 {conflict} 开始</button>
        </p>
      )}

      <label className="block">
        <span className="text-[11px] text-ink-500">备注</span>
        <textarea className="input mt-1 min-h-[56px] resize-y" value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="输出 / 方法 / 范围说明（可选）" maxLength={2000} />
      </label>

      <PredecessorPicker candidates={candidates} selected={f.predecessors} onToggle={toggle} />
    </EditorDrawer>
  )
}
