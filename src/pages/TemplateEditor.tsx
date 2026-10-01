// 模板结构编辑器 —— 可视化增删/编辑三级 WBS（子项目 + 任务/里程碑 + 前置依赖），保存为新版本。
//
// 解决「空白模板无法编辑」的问题：任何模板（含空白）都能在此逐级搭建结构。
// 纯结构操作走 lib/templateStructure（不可变更新）；保存走 data/bootstrap.saveTemplateStructure（API + 离线 mock）。

import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Save, Loader2, Plus, Trash2, Diamond, X, ChevronDown, ChevronRight,
  AlertTriangle, PencilLine, ListChecks,
} from 'lucide-react'
import { Card, CardBody, Button, Tag, EmptyState } from '../components/ui'
import { modules, stages, specialtyGroups } from '../mock'
import type { Module, SpecialtyGroup, Stage, Template, TemplateNode, TemplateVersion } from '../types'
import { useTemplatesStore } from '../store/templates'
import { useDataStore } from '../store/data'
import { saveTemplateStructure } from '../data/bootstrap'
import {
  cloneTree, countStructure, nextVersionNumber, allTaskCodes, nodeToFields,
  addSubProject, updateSubProject, deleteSubProject, addTask, updateTask, deleteTask,
  type SubFields, type TaskFields, type TaskCodeRef,
} from '../lib/templateStructure'
import { cn } from '../lib/cn'

type TaskEditorState =
  | { mode: 'create'; subId: string }
  | { mode: 'edit'; subId: string; taskId: string; task: TemplateNode }

export default function TemplateEditor() {
  const { id } = useParams()
  const template = useTemplatesStore((s) => s.templates.find((t) => t.id === id))
  const version = template?.versions.find((v) => v.isCurrent)

  if (!template || !version) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card><EmptyState title="模板不存在" description="该模板可能已被删除。" /></Card>
      </div>
    )
  }

  // 模板切换时建立新草稿；同一模板刷新时保留未保存的编辑。
  return <TemplateEditorForm key={template.id} template={template} version={version} />
}

function TemplateEditorForm({ template, version }: { template: Template; version: TemplateVersion }) {
  const navigate = useNavigate()
  const mode = useDataStore((s) => s.mode)
  const [draft, setDraft] = useState<TemplateNode>(() => cloneTree(version.structureJson))
  const [taskEditor, setTaskEditor] = useState<TaskEditorState | null>(null)
  const [addingSub, setAddingSub] = useState(false)
  const [summary, setSummary] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const codes = useMemo<TaskCodeRef[]>(() => allTaskCodes(draft), [draft])
  const counts = countStructure(draft)

  const subs = draft.children ?? []
  const nextVer = nextVersionNumber(template.currentVersion)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveTemplateStructure(template.id, draft, nextVer, summary.trim() || '可视化结构编辑')
      navigate(`/templates/${template.id}`)
    } catch (e) {
      console.error(e)
      setError('保存失败，请确认后端已启动后重试。')
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto pb-28">
      <Link to={`/templates/${template.id}`} className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 mb-3">
        <ArrowLeft className="w-3 h-3" /> 返回模板详情
      </Link>

      {/* 头部 */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2">
            <PencilLine className="w-5 h-5 text-brand-600" /> 编辑模板结构
          </h1>
          <p className="text-sm text-ink-500 mt-1">
            {template.name} · 当前 {template.currentVersion}
            <span className="mx-1 text-ink-400">→</span>
            <Tag tone="blue">保存为 {nextVer}</Tag>
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-500 shrink-0">
          <span><b className="text-ink-800">{counts.subProjects}</b> 子项目</span>
          <span><b className="text-ink-800">{counts.tasks}</b> 任务</span>
          <span className="inline-flex items-center gap-0.5"><Diamond className="w-3 h-3 text-amber-600" /><b className="text-ink-800">{counts.milestones}</b> 里程碑</span>
        </div>
      </div>

      {mode === 'mock' && (
        <div className="mb-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
          离线模式 · 保存不持久化（后端启动后刷新即可写入）
        </div>
      )}

      {/* 子项目列表 */}
      <div className="space-y-3">
        {subs.length === 0 && !addingSub && (
          <Card>
            <EmptyState
              title="还没有子项目"
              description="模板由「子项目（Lv2）→ 任务（Lv3）」组成。先添加一个子项目，再往里加任务。"
              action={<Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setAddingSub(true)}>添加子项目</Button>}
            />
          </Card>
        )}

        {subs.map((sub) => (
          <SubCard
            key={sub.id}
            sub={sub}
            onUpdate={(f) => setDraft((d) => (d ? updateSubProject(d, sub.id, f) : d))}
            onDelete={() => setDraft((d) => (d ? deleteSubProject(d, sub.id) : d))}
            onAddTask={() => setTaskEditor({ mode: 'create', subId: sub.id })}
            onEditTask={(task) => setTaskEditor({ mode: 'edit', subId: sub.id, taskId: task.id, task })}
            onDeleteTask={(taskId) => setDraft((d) => (d ? deleteTask(d, taskId) : d))}
          />
        ))}

        {addingSub ? (
          <Card><CardBody><AddSubForm onCancel={() => setAddingSub(false)} onSubmit={(f) => { setDraft((d) => (d ? addSubProject(d, f) : d)); setAddingSub(false) }} /></CardBody></Card>
        ) : subs.length > 0 && (
          <button
            onClick={() => setAddingSub(true)}
            className="w-full py-2.5 rounded-md border border-dashed border-ink-300 text-sm text-ink-500 hover:border-brand-400 hover:text-brand-600 hover:bg-brand-50/40 transition-colors inline-flex items-center justify-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> 添加子项目
          </button>
        )}
      </div>

      {/* 固定底部保存条 */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-ink-300/50 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] z-30">
        <div className="max-w-[1200px] mx-auto px-6 py-3 flex items-center gap-3">
          <input
            className="input flex-1 max-w-md" value={summary} onChange={(e) => setSummary(e.target.value)}
            placeholder="变更说明（可选，如：新增 HCP 方法开发任务）"
          />
          {error && <span className="text-xs text-red-600 inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{error}</span>}
          <div className="flex-1" />
          <Button variant="secondary" disabled={saving} onClick={() => navigate(`/templates/${template.id}`)}>取消</Button>
          <Button
            variant="primary" disabled={saving}
            icon={saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            onClick={save}
          >
            {saving ? '保存中…' : `保存为 ${nextVer}`}
          </Button>
        </div>
      </div>

      {/* 任务编辑抽屉 */}
      {taskEditor && (
        <TaskEditDrawer
          key={taskEditor.mode === 'edit' ? taskEditor.taskId : 'create'}
          state={taskEditor}
          allCodes={codes}
          onClose={() => setTaskEditor(null)}
          onSubmit={(fields) => {
            setDraft((d) => {
              if (!d) return d
              return taskEditor.mode === 'create'
                ? addTask(d, taskEditor.subId, fields)
                : updateTask(d, taskEditor.taskId, fields)
            })
            setTaskEditor(null)
          }}
        />
      )}
    </div>
  )
}

// ============= 子项目卡片 =============

function SubCard({ sub, onUpdate, onDelete, onAddTask, onEditTask, onDeleteTask }: {
  sub: TemplateNode
  onUpdate: (f: SubFields) => void
  onDelete: () => void
  onAddTask: () => void
  onEditTask: (task: TemplateNode) => void
  onDeleteTask: (taskId: string) => void
}) {
  const [open, setOpen] = useState(true)
  const [confirmDel, setConfirmDel] = useState(false)
  const tasks = sub.children ?? []

  return (
    <Card className="overflow-visible">
      {/* 头部：可编辑名称 / 模块 / 阶段 */}
      <div className="px-3 py-2 bg-purple-50/70 border-b border-purple-200/60 flex items-center gap-2 flex-wrap">
        <button onClick={() => setOpen((v) => !v)} className="text-ink-500 shrink-0">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-purple-200 text-purple-800 shrink-0">Lv2</span>
        <input
          className="text-sm font-semibold bg-transparent border border-transparent hover:border-ink-300 focus:border-brand-400 focus:bg-white rounded px-1.5 py-0.5 min-w-[160px] flex-1 focus:outline-none"
          value={sub.name}
          onChange={(e) => onUpdate({ name: e.target.value, module: sub.module, stage: sub.stage })}
          placeholder="子项目名称"
        />
        <select
          className="h-7 text-xs rounded border border-ink-300 bg-white px-1.5 focus:border-brand-400 focus:outline-none"
          value={sub.module ?? ''} onChange={(e) => onUpdate({ name: sub.name, module: (e.target.value || undefined) as Module | undefined, stage: sub.stage })}
        >
          <option value="">模块…</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          className="h-7 text-xs rounded border border-ink-300 bg-white px-1.5 focus:border-brand-400 focus:outline-none"
          value={sub.stage ?? ''} onChange={(e) => onUpdate({ name: sub.name, module: sub.module, stage: (e.target.value || undefined) as Stage | undefined })}
        >
          <option value="">阶段…</option>
          {stages.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-[11px] text-ink-500">{tasks.length} 任务</span>
        <div className="flex-1" />
        {confirmDel ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className="text-red-600">删除「{sub.name}」及其 {tasks.length} 个任务？</span>
            <button className="text-red-600 font-medium hover:underline" onClick={onDelete}>确认</button>
            <button className="text-ink-500 hover:underline" onClick={() => setConfirmDel(false)}>取消</button>
          </span>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="p-1 rounded hover:bg-red-50 text-ink-400 hover:text-red-600" title="删除子项目">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && (
        <ul className="divide-y divide-ink-200/60">
          {tasks.map((t) => <TaskRow key={t.id} task={t} onEdit={() => onEditTask(t)} onDelete={() => onDeleteTask(t.id)} />)}
          {tasks.length === 0 && <li className="px-3 py-2.5 text-xs text-ink-400 italic">暂无任务，点击下方「添加任务」</li>}
          <li className="px-2 py-1.5">
            <button onClick={onAddTask} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:bg-brand-50 px-2 py-1 rounded">
              <Plus className="w-3.5 h-3.5" /> 添加任务 / 里程碑
            </button>
          </li>
        </ul>
      )}
    </Card>
  )
}

function TaskRow({ task, onEdit, onDelete }: { task: TemplateNode; onEdit: () => void; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 group hover:bg-ink-100/40">
      {task.isMilestone
        ? <Diamond className="w-3.5 h-3.5 text-amber-600 shrink-0" />
        : <span className="text-[9px] font-mono px-1 rounded bg-emerald-100 text-emerald-800 shrink-0">L3</span>}
      <span className="text-[10px] font-mono text-ink-400 shrink-0 w-16">{task.taskCode}</span>
      <button onClick={onEdit} className={cn('text-sm flex-1 truncate text-left hover:text-brand-700 hover:underline', task.isMilestone && 'font-semibold')}>
        {task.name}
      </button>
      {task.defaultRole && <Tag tone="gray">{task.defaultRole}</Tag>}
      {!task.isMilestone && task.defaultDuration !== undefined && <span className="text-[10px] text-ink-500 shrink-0">{task.defaultDuration}d</span>}
      {!task.isMilestone && task.defaultEffort !== undefined && <span className="text-[10px] text-ink-500 shrink-0">{task.defaultEffort}人天</span>}
      {task.predecessors && task.predecessors.length > 0 && (
        <span className="text-[10px] text-ink-400 shrink-0">← {task.predecessors.map((p) => p.taskCode).join(', ')}</span>
      )}
      <button onClick={onEdit} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-ink-100 text-ink-400 hover:text-brand-600 transition-opacity shrink-0" title="编辑">
        <PencilLine className="w-3.5 h-3.5" />
      </button>
      <button onClick={onDelete} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-ink-400 hover:text-red-600 transition-opacity shrink-0" title="删除">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </li>
  )
}

// ============= 添加子项目表单 =============

function AddSubForm({ onSubmit, onCancel }: { onSubmit: (f: SubFields) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [module, setModule] = useState<Module | ''>('')
  const [stage, setStage] = useState<Stage | ''>('')
  const valid = name.trim().length > 0
  return (
    <div className="flex items-end gap-2 flex-wrap">
      <label className="block">
        <span className="text-[11px] text-ink-500">子项目名称 *</span>
        <input autoFocus className="input mt-1 w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：上游工艺开发 (USP)" />
      </label>
      <label className="block">
        <span className="text-[11px] text-ink-500">模块</span>
        <select className="input mt-1" value={module} onChange={(e) => setModule(e.target.value as Module | '')}>
          <option value="">—</option>
          {modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-[11px] text-ink-500">阶段</span>
        <select className="input mt-1" value={stage} onChange={(e) => setStage(e.target.value as Stage | '')}>
          <option value="">—</option>
          {stages.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <div className="flex-1" />
      <Button variant="secondary" size="sm" onClick={onCancel}>取消</Button>
      <Button variant="primary" size="sm" disabled={!valid} icon={<Plus className="w-3.5 h-3.5" />}
        onClick={() => onSubmit({ name, module: module || undefined, stage: stage || undefined })}>
        添加
      </Button>
    </div>
  )
}

// ============= 任务编辑抽屉 =============

function TaskEditDrawer({ state, allCodes, onClose, onSubmit }: {
  state: TaskEditorState
  allCodes: TaskCodeRef[]
  onClose: () => void
  onSubmit: (fields: TaskFields) => void
}) {
  const editing = state.mode === 'edit' ? state.task : null
  const init = editing ? nodeToFields(editing) : {
    name: '', isMilestone: false, defaultRole: undefined, defaultDuration: 14, defaultEffort: 2,
    costBudget: undefined, description: '', ctdSection: '', output: '', regulatoryRef: '', predecessorCodes: [],
  } as TaskFields

  const [f, setF] = useState<TaskFields>(init)
  const [predOpen, setPredOpen] = useState(false)
  const set = (patch: Partial<TaskFields>) => setF((prev) => ({ ...prev, ...patch }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 前驱候选：排除自身编号
  const ownCode = editing?.taskCode
  const candidates = allCodes.filter((c) => c.code !== ownCode)
  const valid = f.name.trim().length > 0

  const toggleParent = (code: string) =>
    set({ predecessorCodes: f.predecessorCodes.includes(code) ? f.predecessorCodes.filter((c) => c !== code) : [...f.predecessorCodes, code] })

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-[520px] bg-white shadow-2xl overflow-y-auto flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold text-ink-900 flex-1">{editing ? '编辑任务' : '新建任务'}</h2>
          {editing?.taskCode && <Tag tone="gray">{editing.taskCode}</Tag>}
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 px-5 py-4 space-y-3.5">
          <label className="block">
            <span className="text-[11px] text-ink-500">任务名称 <span className="text-red-500">*</span></span>
            <input className={cn('input mt-1', !valid && 'border-red-300')} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="如：宿主细胞蛋白(HCP)方法开发" />
          </label>

          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={f.isMilestone} onChange={(e) => set({ isMilestone: e.target.checked })} className="accent-brand-600" />
            <Diamond className="w-3.5 h-3.5 text-amber-600" /> 里程碑（无工期/工时，达成型节点）
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">负责组</span>
              <select className="input mt-1" value={f.defaultRole ?? ''} onChange={(e) => set({ defaultRole: (e.target.value || undefined) as SpecialtyGroup | undefined })}>
                <option value="">—</option>
                {specialtyGroups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">成本预算（万）</span>
              <input type="number" min={0} className="input mt-1" value={f.costBudget ?? ''} onChange={(e) => set({ costBudget: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="可选" />
            </label>
            {!f.isMilestone && (
              <>
                <label className="block">
                  <span className="text-[11px] text-ink-500">工期（天）</span>
                  <input type="number" min={0} className="input mt-1" value={f.defaultDuration ?? ''} onChange={(e) => set({ defaultDuration: e.target.value === '' ? 0 : Number(e.target.value) })} />
                </label>
                <label className="block">
                  <span className="text-[11px] text-ink-500">工时（人天）</span>
                  <input type="number" min={0} step={0.5} className="input mt-1" value={f.defaultEffort ?? ''} onChange={(e) => set({ defaultEffort: e.target.value === '' ? 0 : Number(e.target.value) })} />
                </label>
              </>
            )}
          </div>

          <label className="block">
            <span className="text-[11px] text-ink-500">描述</span>
            <textarea className="input mt-1 min-h-[56px] resize-y" value={f.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="输出/方法/范围说明（可选）" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">CTD 章节</span>
              <input className="input mt-1" value={f.ctdSection ?? ''} onChange={(e) => set({ ctdSection: e.target.value })} placeholder="如 3.2.S.2.2" />
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">输出物</span>
              <input className="input mt-1" value={f.output ?? ''} onChange={(e) => set({ output: e.target.value })} placeholder="可交付物（可选）" />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] text-ink-500">监管依据</span>
            <input className="input mt-1" value={f.regulatoryRef ?? ''} onChange={(e) => set({ regulatoryRef: e.target.value })} placeholder="ICH/FDA/NMPA 等引用（可选）" />
          </label>

          {/* 前置依赖 */}
          <div>
            <button type="button" onClick={() => setPredOpen((v) => !v)} className="w-full flex items-center gap-1.5 text-[11px] text-ink-500 uppercase tracking-wider">
              <ListChecks className="w-3.5 h-3.5" /> 前置依赖
              <Tag tone="gray">{f.predecessorCodes.length}</Tag>
              {predOpen ? <ChevronDown className="w-3.5 h-3.5 ml-auto" /> : <ChevronRight className="w-3.5 h-3.5 ml-auto" />}
            </button>
            {predOpen && (
              <div className="mt-2 border border-ink-300/60 rounded-md max-h-[200px] overflow-y-auto divide-y divide-ink-200/60">
                {candidates.length === 0 ? (
                  <div className="p-3 text-center text-xs text-ink-400">暂无其它任务可作为前置</div>
                ) : candidates.map((c) => {
                  const checked = f.predecessorCodes.includes(c.code)
                  return (
                    <label key={c.code} className={cn('flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-brand-50/40', checked && 'bg-brand-50/60')}>
                      <input type="checkbox" checked={checked} onChange={() => toggleParent(c.code)} className="accent-brand-600" />
                      <span className="font-mono text-[10px] text-ink-400 w-16 shrink-0">{c.code}</span>
                      <span className="text-xs truncate flex-1">{c.name}</span>
                      <span className="text-[10px] text-ink-400 shrink-0">{c.subName}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" disabled={!valid} icon={<Save className="w-3.5 h-3.5" />} onClick={() => onSubmit(f)}>
            {editing ? '保存' : '添加任务'}
          </Button>
        </div>
      </div>
    </div>
  )
}
