// 模板结构编辑器 —— 可视化增删/编辑三级 WBS（子项目 + 任务/里程碑 + 前置依赖），保存为新版本。
//
// 解决「空白模板无法编辑」的问题：任何模板（含空白）都能在此逐级搭建结构。
// 纯结构操作走 lib/templateStructure（不可变更新）；保存走 data/bootstrap.saveTemplateStructure（API + 离线 mock）。
// 界面与项目「编辑模式」共用 components/structure/StructureEditorKit，两处用法一致。

import { useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Plus, Diamond, PencilLine } from 'lucide-react'
import { Card, CardBody, Button, Tag, EmptyState } from '../components/ui'
import { specialtyGroups } from '../mock'
import type { SpecialtyGroup, Template, TemplateNode, TemplateVersion } from '../types'
import { useTemplatesStore } from '../store/templates'
import { useDataStore } from '../store/data'
import { saveTemplateStructure } from '../data/bootstrap'
import {
  cloneTree, countStructure, nextVersionNumber, allTaskCodes, nodeToFields,
  addSubProject, updateSubProject, deleteSubProject, addTask, updateTask, deleteTask,
  type TaskFields, type TaskCodeRef,
} from '../lib/templateStructure'
import {
  AddSubButton, AddSubForm, EditorDrawer, PredecessorPicker, SaveBar, StructureCounts, SubCard, TaskRow,
} from '../components/structure/StructureEditorKit'
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
        <StructureCounts {...counts} />
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

        {subs.map((sub) => {
          const tasks = sub.children ?? []
          return (
            <SubCard
              key={sub.id}
              value={{ name: sub.name, module: sub.module, stage: sub.stage }}
              taskCount={tasks.length}
              onChange={(f) => setDraft((d) => (d ? updateSubProject(d, sub.id, f) : d))}
              onDelete={() => setDraft((d) => (d ? deleteSubProject(d, sub.id) : d))}
              onAddTask={() => setTaskEditor({ mode: 'create', subId: sub.id })}
            >
              {tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  code={t.taskCode}
                  name={t.name}
                  isMilestone={!!t.isMilestone}
                  tag={t.defaultRole}
                  durationDays={t.defaultDuration}
                  effort={t.defaultEffort}
                  predecessorCodes={(t.predecessors ?? []).map((p) => p.taskCode)}
                  onEdit={() => setTaskEditor({ mode: 'edit', subId: sub.id, taskId: t.id, task: t })}
                  onDelete={() => setDraft((d) => (d ? deleteTask(d, t.id) : d))}
                />
              ))}
            </SubCard>
          )
        })}

        {addingSub ? (
          <Card><CardBody><AddSubForm onCancel={() => setAddingSub(false)} onSubmit={(f) => { setDraft((d) => (d ? addSubProject(d, f) : d)); setAddingSub(false) }} /></CardBody></Card>
        ) : subs.length > 0 && <AddSubButton onClick={() => setAddingSub(true)} />}
      </div>

      {/* 固定底部保存条 */}
      <SaveBar
        summary={summary}
        onSummary={setSummary}
        error={error}
        saving={saving}
        saveLabel={`保存为 ${nextVer}`}
        onCancel={() => navigate(`/templates/${template.id}`)}
        onSave={save}
      />

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
  const set = (patch: Partial<TaskFields>) => setF((prev) => ({ ...prev, ...patch }))

  // 前驱候选：排除自身编号
  const ownCode = editing?.taskCode
  const candidates = allCodes.filter((c) => c.code !== ownCode).map((c) => ({ id: c.code, code: c.code, name: c.name, subName: c.subName }))
  const valid = f.name.trim().length > 0

  const toggleParent = (code: string) =>
    set({ predecessorCodes: f.predecessorCodes.includes(code) ? f.predecessorCodes.filter((c) => c !== code) : [...f.predecessorCodes, code] })

  return (
    <EditorDrawer
      title={editing ? '编辑任务' : '新建任务'}
      code={editing?.taskCode}
      onClose={onClose}
      onSubmit={() => onSubmit(f)}
      submitLabel={editing ? '保存' : '添加任务'}
      submitDisabled={!valid}
    >
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

      <PredecessorPicker candidates={candidates} selected={f.predecessorCodes} onToggle={toggleParent} />
    </EditorDrawer>
  )
}
