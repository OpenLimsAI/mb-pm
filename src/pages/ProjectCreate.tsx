import { useState, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, CheckCircle2, FileText, Sparkles, Diamond,
  Calendar, ChevronDown, ChevronRight, Users, X, Plus, Search, Trash2,
} from 'lucide-react'
import { Card, CardBody, Button, Tag, Avatar } from '../components/ui'
import { users, productTypes, stages, TODAY } from '../mock'
import { useTemplatesStore } from '../store/templates'
import { createProjectBundle } from '../data/bootstrap'
import { instantiateTemplate, deriveRollup } from '../lib/instantiate'
import type { ProductType, Project, Stage, TemplateNode, User } from '../types'
import { roleLabels } from '../lib/permissions'
import { cn } from '../lib/cn'

type Step = 1 | 2 | 3 | 4

export default function ProjectCreate() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(1)

  // Step 1 输入
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [productType, setProductType] = useState<ProductType>('单抗')
  const [currentStage, setCurrentStage] = useState<Stage>('IND')
  const [targetStage, setTargetStage] = useState<Stage>('BLA')
  const [ownerId, setOwnerId] = useState<string>('')
  const [memberIds, setMemberIds] = useState<string[]>([])  // 项目团队成员（可选）
  const [plannedStart, setPlannedStart] = useState(() => TODAY.toISOString().slice(0, 10))
  const [description, setDescription] = useState('')

  // Step 2
  const allTemplates = useTemplatesStore((s) => s.templates)
  const matchedTemplates = useMemo(() => allTemplates.filter((t) => t.productType === productType && t.isActive), [allTemplates, productType])
  const [templateId, setTemplateId] = useState<string>('')
  const selectedTemplate = useMemo(() => allTemplates.find((t) => t.id === templateId), [allTemplates, templateId])
  const selectedVersion = selectedTemplate?.versions.find((v) => v.isCurrent)

  // Step 3 — 已生成的任务树（可调整）
  const projectLeads = users.filter((u) => u.role === 'project_lead' || u.role === 'cmc_lead')

  const step1Valid = name && code && ownerId
  // 模板存在且产品类型一致才放行（纵深防御：即便 templateId 残留也挡住跨类型模板）
  const step2Valid = !!selectedTemplate && selectedTemplate.productType === productType

  // —— 真正创建项目（实例化模板 → 写入后端 / mock 运行时数组）—— //
  const [createdProjectId, setCreatedProjectId] = useState('')
  const [createdTaskCount, setCreatedTaskCount] = useState(0)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Step 3 — 可编辑的任务树草稿（增删任务后再创建）
  const [draft, setDraft] = useState<TemplateNode | null>(null)
  const [draftVersionId, setDraftVersionId] = useState<string>('')
  const effectiveStructure = draft ?? selectedVersion?.structureJson
  // 按层级精确统计 Lv3 任务/里程碑（避免「被删空的子项目」被叶子启发式误计为 1 个任务）
  const draftCounts = effectiveStructure ? countLeafTasks(effectiveStructure) : { tasks: 0, milestones: 0 }
  const draftTaskCount = draftCounts.tasks
  const draftMilestoneCount = draftCounts.milestones
  const originalTaskCount = selectedVersion ? countLeafTasks(selectedVersion.structureJson).tasks : 0
  const modified = !!draft && draftTaskCount !== originalTaskCount

  // 项目总预算（万元）：默认 = 任务预算合计，与「已花费 = 任务实际花费合计」同口径；null = 用默认值
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null)
  const suggestedBudget = Math.round(sumCost(effectiveStructure) * 100) / 100
  const budgetValue = budgetDraft === null ? suggestedBudget : budgetDraft.trim() === '' ? NaN : Number(budgetDraft)
  const budgetInvalid = !Number.isFinite(budgetValue) || budgetValue < 0 || budgetValue > 99_999_999

  // 进入第 3 步：首次或换模板时，用模板结构初始化草稿（同模板返回不丢失已编辑内容）
  const enterStep3 = () => {
    if (selectedVersion && draftVersionId !== selectedVersion.id) {
      setDraft(JSON.parse(JSON.stringify(selectedVersion.structureJson)) as TemplateNode)
      setDraftVersionId(selectedVersion.id)
    }
    setStep(3)
  }

  const deleteTask = (taskId: string) => setDraft((prev) => {
    if (!prev) return prev
    const next = JSON.parse(JSON.stringify(prev)) as TemplateNode
    // 取被删任务的 taskCode，用于同步清理其它任务对它的悬挂前驱引用（预览与实例化一致）
    let deletedCode: string | undefined
    for (const sub of next.children ?? []) {
      const found = sub.children?.find((t) => t.id === taskId)
      if (found) deletedCode = found.taskCode
    }
    for (const sub of next.children ?? []) {
      if (!sub.children) continue
      sub.children = sub.children.filter((t) => t.id !== taskId)
      if (deletedCode) {
        for (const t of sub.children) {
          if (t.predecessors) t.predecessors = t.predecessors.filter((p) => p.taskCode !== deletedCode)
        }
      }
    }
    return next
  })

  const addTask = (subId: string, input: NewTaskInput) => setDraft((prev) => {
    if (!prev) return prev
    const next = JSON.parse(JSON.stringify(prev)) as TemplateNode
    const sub = next.children?.find((s) => s.id === subId)
    if (!sub) return next
    if (!sub.children) sub.children = []
    sub.children.push({
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      taskCode: nextTaskCode(sub),
      name: input.name.trim(),
      module: sub.module,
      stage: sub.stage,
      defaultRole: sub.defaultRole,
      defaultDuration: input.isMilestone ? 0 : input.duration,
      defaultEffort: input.isMilestone ? 0 : input.effort,
      isMilestone: input.isMilestone,
    })
    return next
  })

  const handleCreate = async () => {
    if (!selectedTemplate || !selectedVersion || creating || createdProjectId) return
    setCreating(true)
    setCreateError(null)
    try {
      // 抗碰撞 id：毫秒时间戳 + 随机后缀
      const projectId = `pu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const now = TODAY  // 与演示快照统一锚点
      // 使用用户在第 3 步增删后的草稿结构（无草稿则用原模板）
      const structure = draft ?? selectedVersion.structureJson
      const inst = instantiateTemplate(structure, {
        projectId,
        projectCode: code,
        projectStartDate: plannedStart,
        // 简化：所有专业组任务均落到项目负责人名下
        ownerByRole: { '上游': ownerId, '下游': ownerId, '制剂': ownerId, '分析': ownerId, '稳定性': ownerId, '工艺验证': ownerId, 'CMC综合': ownerId },
        fallbackOwnerId: ownerId,
        today: now,
      })
      const rollup = deriveRollup(inst.tasks, now)
      const plannedEnd = inst.tasks.reduce((mx, t) => (t.plannedEnd > mx ? t.plannedEnd : mx), plannedStart)
      const project: Project = {
        id: projectId,
        code,
        name,
        productType,
        currentStage,
        targetStage,
        ownerId,
        memberIds,
        status: '活跃',
        health: rollup.health,
        plannedStart,
        plannedEnd,
        templateId: selectedTemplate.id,
        templateVersion: selectedVersion.versionNumber,
        description,
        progress: rollup.progress,
      }
      // 总预算：默认为任务预算合计（第 3 步可修改）；已花费由任务实际花费自动汇总
      const totalBudget = Math.round(budgetValue * 100) / 100
      const finance = {
        projectId,
        totalBudget,
        spent: 0,
        committed: 0,
        breakdown: { '人力': 0, '设备': 0, '原材料': 0, '外部服务': 0, '其他': 0 },
        fiscalYear: `${plannedStart.slice(0, 4)}-${plannedEnd.slice(0, 4)}`,
        notes: '新建项目，尚未发生支出',
      }
      const newId = await createProjectBundle({
        project, subProjects: inst.subProjects, tasks: inst.tasks, dependencies: inst.dependencies, finance,
      })
      setCreatedProjectId(newId)
      setCreatedTaskCount(inst.tasks.length)
      setStep(4)
    } catch (e) {
      console.error('创建项目失败:', e)
      setCreateError('创建失败，请确认后端已启动后重试。')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link to="/projects" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 mb-3">
        <ArrowLeft className="w-3 h-3" /> 返回项目列表
      </Link>
      <h1 className="text-2xl font-semibold text-ink-900 mb-1">创建新项目</h1>
      <p className="text-sm text-ink-500 mb-5">系统将根据模板自动生成完整的三级任务树（FR-PF-001）</p>

      {/* Stepper */}
      <Stepper step={step} />

      <Card className="mt-4">
        <CardBody className="p-6">
          {step === 1 && (
            <div className="space-y-4 max-w-2xl">
              <h2 className="text-lg font-medium mb-4">基本信息</h2>
              <div className="grid grid-cols-2 gap-4">
                <Field label="项目编号 *" hint="如：CMAB00028">
                  <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CMAB00028" />
                </Field>
                <Field label="项目负责人 *">
                  <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                    <option value="">请选择</option>
                    {projectLeads.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                  </select>
                </Field>
              </div>

              <Field label="项目名称 *">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：CMAB-28 抗XX单抗" />
              </Field>

              <div className="grid grid-cols-3 gap-4">
                <Field label="产品类型 *">
                  <select
                    className="input" value={productType}
                    onChange={(e) => {
                      // 切换产品类型须重选模板：清掉旧模板与第 3 步草稿，避免「产品类型 vs 模板」不一致的项目
                      setProductType(e.target.value as ProductType)
                      setTemplateId('')
                      setDraft(null)
                      setDraftVersionId('')
                    }}
                  >
                    {productTypes.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
                <Field label="当前阶段 *">
                  <select className="input" value={currentStage} onChange={(e) => setCurrentStage(e.target.value as Stage)}>
                    {stages.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="目标阶段 *">
                  <select className="input" value={targetStage} onChange={(e) => setTargetStage(e.target.value as Stage)}>
                    {stages.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
              </div>

              <Field label="计划开始日期 *">
                <input type="date" className="input max-w-xs" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} />
              </Field>

              <Field label="项目团队成员（可选）" hint="跨职能成员，参与项目但不担任 PM。如：上游/下游/分析/QA 协作人员">
                <TeamSelector
                  selectedIds={memberIds}
                  onChange={setMemberIds}
                  excludeId={ownerId}
                />
              </Field>

              <Field label="项目描述">
                <textarea className="input min-h-[80px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="项目背景与重点说明" />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-lg font-medium mb-1">选择项目模板</h2>
              <p className="text-sm text-ink-500 mb-4">
                系统根据「{productType}」自动推荐 {matchedTemplates.length} 个匹配的模板。
                <Sparkles className="w-3 h-3 inline-block mx-1 text-amber-500" />
                选定模板后，系统将一键生成完整三级任务树。
              </p>

              <div className="space-y-3">
                {matchedTemplates.map((t) => {
                  const v = t.versions.find((vv) => vv.isCurrent)
                  const taskCount = countNodes(v?.structureJson, 'task')
                  const subCount = countNodes(v?.structureJson, 'sub')
                  const milestoneCount = countMilestones(v?.structureJson)
                  const active = templateId === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTemplateId(t.id)}
                      className={cn(
                        'w-full text-left p-4 rounded-md border transition-all',
                        active ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20' : 'border-ink-300 hover:border-brand-300 hover:bg-ink-100'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          'w-10 h-10 rounded-md flex items-center justify-center shrink-0',
                          active ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-600'
                        )}>
                          <FileText className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-ink-900">{t.name}</span>
                            <Tag tone="blue">{t.currentVersion}</Tag>
                            {active && <CheckCircle2 className="w-4 h-4 text-brand-600" />}
                          </div>
                          <p className="text-xs text-ink-500 mb-2">{t.description}</p>
                          <div className="flex items-center gap-4 text-xs">
                            <span className="text-ink-500">子项目 <span className="font-medium text-ink-900">{subCount}</span></span>
                            <span className="text-ink-500">任务 <span className="font-medium text-ink-900">{taskCount}</span></span>
                            <span className="text-ink-500 flex items-center gap-1">
                              <Diamond className="w-3 h-3" />
                              里程碑 <span className="font-medium text-ink-900">{milestoneCount}</span>
                            </span>
                            <span className="text-ink-500">最近更新 {t.updatedAt.slice(0, 10)}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {matchedTemplates.length === 0 && (
                  <div className="text-center py-8 text-ink-500">
                    <p className="text-sm">没有找到「{productType}」的可用模板</p>
                    <Link to="/templates" className="text-brand-600 text-xs hover:underline">前往模板管理 →</Link>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && selectedVersion && effectiveStructure && (
            <div>
              <h2 className="text-lg font-medium mb-1">预览并调整任务树</h2>
              <p className="text-sm text-ink-500 mb-4">
                以下为系统根据模板 <span className="font-medium text-ink-900">{selectedTemplate?.name} {selectedVersion.versionNumber}</span> 生成的三级 WBS。
                你可以在此<span className="text-ink-700 font-medium">增删任务</span>后再创建；分配负责人时系统会自动推荐符合负荷的人员。
              </p>

              <div className="rounded-md border border-ink-300/60 bg-ink-100/40 p-2 max-h-[480px] overflow-y-auto">
                <EditableTaskTree root={effectiveStructure} onDelete={deleteTask} onAdd={addTask} />
              </div>

              <div className="mt-4 px-3 py-2 rounded-md bg-amber-50 text-amber-700 text-xs flex items-start gap-2">
                <Sparkles className="w-3.5 h-3.5 mt-0.5" />
                <span>
                  将生成 <b>{draftTaskCount}</b> 个任务、<b>{draftMilestoneCount}</b> 个里程碑
                  {modified && <span className="ml-1 text-brand-700">（已调整，原模板 {originalTaskCount} 个任务）</span>}。
                  创建后仍可在「项目详情 → WBS / 甘特图」中继续调整。
                </span>
              </div>
              {draftTaskCount === 0 && (
                <div className="mt-2 text-xs text-red-600">请至少保留 1 个任务再创建项目。</div>
              )}

              <div className="mt-4 grid sm:grid-cols-[220px_1fr] gap-3 items-start">
                <label className="text-sm space-y-1.5">
                  <span className="font-medium text-ink-900">项目总预算（万元）</span>
                  <input
                    className={cn('input tabular-nums', budgetInvalid && 'border-red-400')}
                    inputMode="decimal"
                    value={budgetDraft ?? String(suggestedBudget)}
                    onChange={(e) => setBudgetDraft(e.target.value)}
                  />
                  {budgetInvalid && <span className="block text-xs text-red-600">请输入 0–99,999,999 之间的金额</span>}
                </label>
                <p className="text-xs text-ink-500 leading-relaxed sm:mt-7">
                  默认为任务预算合计 ¥{suggestedBudget.toLocaleString('zh-CN')}万（外包 / 耗材 / CRO 等，不含内部人力）。
                  已花费将按任务实际花费自动汇总；创建后系统管理员或 CMC 负责人可在项目概览中调整预算与已承诺。
                  {budgetDraft !== null && (
                    <button type="button" className="ml-1 text-brand-700 hover:underline" onClick={() => setBudgetDraft(null)}>恢复默认</button>
                  )}
                </p>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="text-center py-8 max-w-md mx-auto">
              <div className="w-16 h-16 rounded-full bg-emerald-100 mx-auto flex items-center justify-center mb-4">
                <CheckCircle2 className="w-10 h-10 text-emerald-600" />
              </div>
              <h2 className="text-xl font-semibold text-ink-900 mb-2">项目创建成功 🎉</h2>
              <p className="text-sm text-ink-500 mb-2">
                项目「{name}」（{code}）已基于模板 <span className="font-medium">{selectedTemplate?.name} {selectedVersion?.versionNumber}</span> 创建，并自动生成 {createdTaskCount} 个任务，已加入项目组合。
              </p>
              {memberIds.length > 0 && (
                <p className="text-xs text-ink-500 mb-4">
                  团队 {memberIds.length + 1} 人：负责人 +{' '}
                  <span className="text-ink-700">{memberIds.length}</span> 名跨职能成员
                </p>
              )}
              <div className="flex justify-center gap-2 mt-4">
                <Button variant="secondary" onClick={() => navigate('/projects')}>返回项目列表</Button>
                <Button variant="primary" onClick={() => navigate(`/projects/${createdProjectId}`)} icon={<ArrowRight className="w-4 h-4" />}>
                  进入新项目
                </Button>
              </div>
              <p className="text-[11px] text-ink-500 mt-4 italic">
                项目已持久化（后端 SQLite，刷新/重启不丢失），即时出现在首页组合总览与项目列表中。
              </p>
            </div>
          )}

          {/* Footer 操作 */}
          {step !== 4 && (
            <div className="mt-6 pt-4 border-t border-ink-300/40">
              {createError && (
                <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                  {createError}
                </div>
              )}
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  onClick={() => step > 1 && setStep((s) => (s - 1) as Step)}
                  disabled={step === 1 || creating}
                  icon={<ArrowLeft className="w-4 h-4" />}
                >
                  上一步
                </Button>
                <Button
                  variant="primary"
                  onClick={() => (step === 3 ? handleCreate() : step === 2 ? enterStep3() : setStep((s) => (s + 1) as Step))}
                  disabled={(step === 1 && !step1Valid) || (step === 2 && !step2Valid) || (step === 3 && (draftTaskCount === 0 || budgetInvalid)) || creating}
                  icon={<ArrowRight className="w-4 h-4" />}
                >
                  {step === 3 ? (creating ? '创建中…' : '确认创建') : '下一步'}
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function Stepper({ step }: { step: Step }) {
  const items = [
    { n: 1, label: '基本信息' },
    { n: 2, label: '选择模板' },
    { n: 3, label: '预览任务树' },
    { n: 4, label: '完成' },
  ]
  return (
    <div className="flex items-center gap-2">
      {items.map((it, i) => {
        const done = step > it.n
        const active = step === it.n
        return (
          <div key={it.n} className="flex items-center gap-2 flex-1">
            <div className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0',
              done ? 'bg-emerald-500 text-white' : active ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-500'
            )}>
              {done ? <CheckCircle2 className="w-4 h-4" /> : it.n}
            </div>
            <div className="text-sm">
              <div className={cn(active ? 'text-ink-900 font-medium' : 'text-ink-500')}>{it.label}</div>
            </div>
            {i < items.length - 1 && (
              <div className={cn('flex-1 h-px', done ? 'bg-emerald-500' : 'bg-ink-300')} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-ink-500 mt-0.5">{hint}</p>}
    </div>
  )
}

interface NewTaskInput { name: string; duration: number; effort: number; isMilestone: boolean }

/** 在子项目下生成下一个任务编号（继承既有兄弟节点的前缀，如 USP-016）。 */
function nextTaskCode(sub: TemplateNode): string {
  const codes = (sub.children ?? []).map((c) => c.taskCode).filter((x): x is string => !!x)
  let prefix = sub.module || 'TASK'
  let maxN = 0
  for (const c of codes) {
    const m = c.match(/^(.*)-(\d+)$/)
    if (m) { prefix = m[1]; maxN = Math.max(maxN, parseInt(m[2], 10)) }
  }
  return `${prefix}-${String(maxN + 1).padStart(3, '0')}`
}

/** 可增删任务的三级 WBS 编辑器（项目=根 → 子项目=Lv2 → 任务=Lv3）。 */
function EditableTaskTree({ root, onDelete, onAdd }: {
  root: TemplateNode
  onDelete: (taskId: string) => void
  onAdd: (subId: string, input: NewTaskInput) => void
}) {
  return (
    <ul className="space-y-2">
      {root.children?.map((sub) => (
        <SubGroup key={sub.id} sub={sub} onDelete={onDelete} onAdd={onAdd} />
      ))}
    </ul>
  )
}

function SubGroup({ sub, onDelete, onAdd }: {
  sub: TemplateNode
  onDelete: (id: string) => void
  onAdd: (subId: string, input: NewTaskInput) => void
}) {
  const [open, setOpen] = useState(true)
  const [adding, setAdding] = useState(false)
  const tasks = sub.children ?? []
  return (
    <li className="rounded-md border border-ink-300/50 overflow-hidden bg-white">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-purple-50">
        <button onClick={() => setOpen((v) => !v)} className="text-ink-500">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <span className="text-xs font-mono px-1 rounded bg-purple-200 text-purple-800">Lv2</span>
        <span className="text-sm font-medium flex-1 truncate">{sub.name}</span>
        {sub.module && <Tag tone="gray">{sub.module}</Tag>}
        <span className="text-[11px] text-ink-500">{tasks.length} 任务</span>
        <button
          onClick={() => { setAdding(true); setOpen(true) }}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:bg-brand-50 px-1.5 py-0.5 rounded"
        >
          <Plus className="w-3 h-3" /> 添加任务
        </button>
      </div>
      {open && (
        <ul className="divide-y divide-ink-200/60">
          {tasks.map((t) => <TaskRow key={t.id} task={t} onDelete={onDelete} />)}
          {tasks.length === 0 && !adding && (
            <li className="px-3 py-2 text-xs text-ink-400 italic">该子项目暂无任务，点击「添加任务」创建</li>
          )}
          {adding && (
            <li className="px-2 py-2 bg-brand-50/40">
              <AddTaskForm onCancel={() => setAdding(false)} onSubmit={(input) => { onAdd(sub.id, input); setAdding(false) }} />
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

function TaskRow({ task, onDelete }: { task: TemplateNode; onDelete: (id: string) => void }) {
  const isCustom = task.id.startsWith('custom-')
  return (
    <li className="flex items-center gap-2 px-2 py-1.5 group hover:bg-ink-100/40">
      <span className="w-3" />
      {task.isMilestone && <Diamond className="w-3 h-3 text-amber-600 shrink-0" />}
      <span className="text-xs font-mono px-1 rounded bg-emerald-100 text-emerald-800">Lv3</span>
      {task.taskCode && <span className="text-[10px] font-mono text-ink-500 shrink-0">{task.taskCode}</span>}
      <span className={cn('text-sm flex-1 truncate', task.isMilestone && 'font-semibold')}>{task.name}</span>
      {isCustom && <Tag tone="blue">自定义</Tag>}
      {!task.isMilestone && task.defaultDuration !== undefined && (
        <span className="text-[10px] text-ink-500 flex items-center gap-0.5"><Calendar className="w-3 h-3" />{task.defaultDuration}d</span>
      )}
      {!task.isMilestone && task.defaultEffort !== undefined && (
        <span className="text-[10px] text-ink-500">{task.defaultEffort} 人天</span>
      )}
      {task.predecessors && task.predecessors.length > 0 && (
        <span className="text-[10px] text-ink-500">← {task.predecessors.map((p) => p.taskCode).join(', ')}</span>
      )}
      <button
        onClick={() => onDelete(task.id)}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-ink-400 hover:text-red-600 transition-opacity shrink-0"
        title="删除任务"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </li>
  )
}

function AddTaskForm({ onSubmit, onCancel }: { onSubmit: (input: NewTaskInput) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [duration, setDuration] = useState('14')
  const [effort, setEffort] = useState('2')
  const [isMilestone, setIsMilestone] = useState(false)
  const valid = name.trim().length > 0
  const submit = () => valid && onSubmit({ name, duration: Number(duration) || 0, effort: Number(effort) || 0, isMilestone })
  return (
    <div className="space-y-2">
      <input
        autoFocus className="input"
        value={name} onChange={(e) => setName(e.target.value)}
        placeholder="任务名称，如：宿主细胞蛋白(HCP)方法开发"
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
      />
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1 text-xs text-ink-600">
          <input type="checkbox" checked={isMilestone} onChange={(e) => setIsMilestone(e.target.checked)} className="accent-brand-600" /> 里程碑
        </label>
        {!isMilestone && (
          <>
            <label className="text-xs text-ink-500 flex items-center gap-1">
              工期 <input type="number" min={0} className="input w-16 h-7 px-1.5 text-xs" value={duration} onChange={(e) => setDuration(e.target.value)} /> d
            </label>
            <label className="text-xs text-ink-500 flex items-center gap-1">
              工时 <input type="number" min={0} step={0.5} className="input w-16 h-7 px-1.5 text-xs" value={effort} onChange={(e) => setEffort(e.target.value)} /> 人天
            </label>
          </>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        <Button size="sm" variant="primary" disabled={!valid} onClick={submit} icon={<Plus className="w-3.5 h-3.5" />}>添加</Button>
      </div>
    </div>
  )
}

function countNodes(node: TemplateNode | undefined, type: 'sub' | 'task'): number {
  if (!node) return 0
  let cnt = 0
  if (node.children) {
    for (const c of node.children) {
      const isLeaf = !c.children || c.children.length === 0
      if (type === 'sub' && !isLeaf) cnt++
      if (type === 'task' && isLeaf) cnt++
      cnt += countNodes(c, type)
    }
  }
  return cnt
}

/** 按三级结构精确统计 Lv3 任务/里程碑（root → Lv2 子项目 → Lv3 任务）。
 *  与叶子启发式不同：被删空的子项目（children=[]）不会被误计为任务。 */
function countLeafTasks(root: TemplateNode): { tasks: number; milestones: number } {
  let tasks = 0
  let milestones = 0
  for (const sub of root.children ?? []) {
    for (const t of sub.children ?? []) {
      tasks++
      if (t.isMilestone) milestones++
    }
  }
  return { tasks, milestones }
}

function countMilestones(node: TemplateNode | undefined): number {
  if (!node) return 0
  let c = node.isMilestone ? 1 : 0
  node.children?.forEach((ch) => { c += countMilestones(ch) })
  return c
}

function sumCost(node: TemplateNode | undefined): number {
  if (!node) return 0
  let c = node.costBudget || 0
  node.children?.forEach((ch) => { c += sumCost(ch) })
  return c
}

// ====== 团队成员多选组件 ======
// 候选池：除项目负责人外的所有 active 用户（按专业组分组展示）
function TeamSelector({
  selectedIds,
  onChange,
  excludeId,
}: {
  selectedIds: string[]
  onChange: (ids: string[]) => void
  excludeId?: string
}) {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  // 候选：active + 不是项目负责人本人
  const candidates = useMemo(() => {
    return users.filter((u) =>
      u.isActive
      && u.id !== excludeId
      // 排除系统管理员（不参与具体项目工作）
      && u.role !== 'admin'
    )
  }, [excludeId])

  // 过滤
  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return candidates
    return candidates.filter((u) =>
      u.displayName.toLowerCase().includes(k)
      || u.username.toLowerCase().includes(k)
      || (u.specialtyGroup || '').toLowerCase().includes(k)
    )
  }, [candidates, keyword])

  // 按专业组分组
  const grouped = useMemo(() => {
    const map = new Map<string, User[]>()
    filtered.forEach((u) => {
      const k = u.specialtyGroup || '其他'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(u)
    })
    return Array.from(map.entries())
  }, [filtered])

  const selectedUsers = users.filter((u) => selectedIds.includes(u.id))

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }
  const remove = (id: string) => onChange(selectedIds.filter((x) => x !== id))

  return (
    <div>
      {/* 已选择的成员芯片 + 添加按钮 */}
      <div className="rounded-md border border-ink-300 bg-white p-2 min-h-[42px] flex items-center gap-1.5 flex-wrap">
        {selectedUsers.length === 0 && (
          <span className="text-xs text-ink-500 px-1">尚未选择团队成员</span>
        )}
        {selectedUsers.map((u) => (
          <span
            key={u.id}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-brand-50 border border-brand-200 text-xs"
          >
            <Avatar user={u} size="sm" />
            <span className="text-ink-900">{u.displayName}</span>
            <span className="text-[10px] text-ink-500">{u.specialtyGroup || roleLabels[u.role]}</span>
            <button
              type="button"
              onClick={() => remove(u.id)}
              className="ml-0.5 p-0.5 rounded hover:bg-brand-100 text-ink-500"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
            open ? 'bg-brand-100 text-brand-700' : 'text-brand-600 hover:bg-brand-50'
          )}
        >
          <Plus className="w-3 h-3" /> 添加成员
        </button>
      </div>

      {/* 选择面板 */}
      {open && (
        <div className="mt-2 rounded-md border border-ink-300 bg-white shadow-sm">
          <div className="p-2 border-b border-ink-300/40">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-ink-500" />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索姓名 / 用户名 / 专业组"
                autoFocus
                className="w-full pl-7 pr-2 py-1 rounded text-xs bg-ink-100 border border-transparent focus:outline-none focus:bg-white focus:border-brand-500"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {grouped.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-500">没有匹配的成员</div>
            ) : (
              grouped.map(([group, list]) => (
                <div key={group}>
                  <div className="px-3 py-1.5 bg-ink-100/60 text-[11px] font-medium text-ink-700 sticky top-0">
                    <Users className="w-3 h-3 inline-block mr-1" />
                    {group}
                    <span className="ml-1 text-ink-500">({list.length})</span>
                  </div>
                  {list.map((u) => {
                    const sel = selectedIds.includes(u.id)
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => toggle(u.id)}
                        className={cn(
                          'w-full px-3 py-1.5 flex items-center gap-2 text-left transition-colors',
                          sel ? 'bg-brand-50 hover:bg-brand-100' : 'hover:bg-ink-100'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={sel}
                          readOnly
                          className="w-3 h-3 accent-brand-600"
                        />
                        <Avatar user={u} size="sm" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-ink-900">{u.displayName}</div>
                          <div className="text-[10px] text-ink-500">
                            {roleLabels[u.role]}{u.specialtyGroup ? ` · ${u.specialtyGroup}` : ''}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          <div className="px-3 py-1.5 border-t border-ink-300/40 flex items-center justify-between text-[11px] text-ink-500">
            <span>已选 {selectedIds.length} 人</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-brand-600 hover:underline"
            >
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
