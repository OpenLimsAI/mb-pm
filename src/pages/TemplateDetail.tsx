// 模板详情 —— 完整三级 WBS 展开，呈现「一条研发流程所需的全部项目信息」
//
// 顶部：模板元信息 + 统计（子项目/任务/里程碑/总工时/总成本）
// 主体：按 L2 子项目分组，每组一张任务表，列出每个 L3 任务的关键字段；
//       点击任务行展开「描述 / 输出物 / 监管依据 / 前置依赖 / 协作」全量信息。

import { useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, FileText, Diamond, Flame, Eye, ChevronRight, ChevronDown, ArrowRight, PencilLine, Plus,
} from 'lucide-react'
import { findUser } from '../mock'
import type { TemplateNode } from '../types'
import { Card, CardBody, Button, Tag, Avatar, EmptyState } from '../components/ui'
import { computeStats } from '../lib/template'
import { useTemplatesStore } from '../store/templates'
import { useAuth } from '../store/auth'
import { cn } from '../lib/cn'

const MANAGER_ROLES = ['admin', 'cmc_lead']

export default function TemplateDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const role = useAuth((s) => s.currentUser?.role)
  const canEdit = !!role && MANAGER_ROLES.includes(role)
  const template = useTemplatesStore((s) => s.templates.find((t) => t.id === id))
  const version = template?.versions.find((v) => v.isCurrent)

  const stats = useMemo(() => (version ? computeStats(version.structureJson) : null), [version])
  const totalCost = useMemo(() => (version ? sumCost(version.structureJson) : 0), [version])

  if (!template || !version || !stats) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card><EmptyState title="模板不存在" description="该模板可能已被删除。" /></Card>
      </div>
    )
  }

  const root = version.structureJson
  const subs = root.children || []
  const author = findUser(version.modifiedBy)

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <Link to="/templates" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 mb-3">
        <ArrowLeft className="w-3 h-3" /> 返回模板列表
      </Link>

      {/* 头部 */}
      <Card className="mb-4">
        <CardBody>
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-lg bg-brand-600 text-white flex items-center justify-center shrink-0">
              <FileText className="w-6 h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold text-ink-900">{template.name}</h1>
                <Tag tone="blue">{template.currentVersion}</Tag>
                <Tag tone="gray">{template.productType}</Tag>
                {!template.isActive && <Tag tone="red">已停用</Tag>}
              </div>
              <p className="text-sm text-ink-500 mt-1">{template.description}</p>
              <div className="flex items-center gap-2 mt-2 text-xs text-ink-500">
                {author && <Avatar user={author} size="sm" />}
                <span>维护人 {author?.displayName || '—'} · 更新于 {version.modifiedAt.slice(0, 10)} · 共 {template.versions.length} 个版本</span>
              </div>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              {canEdit && (
                <Button variant="secondary" size="sm" icon={<PencilLine className="w-3.5 h-3.5" />}
                        onClick={() => navigate(`/templates/${template.id}/edit`)}>
                  编辑结构
                </Button>
              )}
              <Button variant="secondary" size="sm" icon={<Eye className="w-3.5 h-3.5" />}
                      onClick={() => navigate(`/templates/${template.id}/preview`)}>
                甘特图预览
              </Button>
              <Button variant="primary" size="sm" icon={<ArrowRight className="w-3.5 h-3.5" />}
                      onClick={() => navigate('/projects/new')}>
                用此模板创建项目
              </Button>
            </div>
          </div>

          {/* 统计 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-4 text-center">
            <Stat label="子项目" value={stats.subProjects} />
            <Stat label="任务" value={stats.tasks} />
            <Stat label="里程碑" value={stats.milestones} icon={<Diamond className="w-3 h-3" />} />
            <Stat label="总工时" value={`${stats.totalEffort} 人天`} />
            <Stat label="预算合计" value={`${totalCost} 万`} />
          </div>
        </CardBody>
      </Card>

      {/* 列说明 */}
      <div className="text-[11px] text-ink-500 mb-2 flex items-center gap-3 flex-wrap px-1">
        <span className="flex items-center gap-1"><Diamond className="w-3 h-3 text-amber-600" /> 里程碑</span>
        <span className="flex items-center gap-1"><Flame className="w-3 h-3 text-rose-500" /> 关键路径</span>
        <span>点击任务行展开完整信息（描述 / 输出物 / 监管依据 / 前置依赖）</span>
      </div>

      {/* 各子项目任务表 / 空白模板引导 */}
      {stats.tasks === 0 && subs.length === 0 ? (
        <Card>
          <EmptyState
            title="此模板暂无结构"
            description="空白模板需要先搭建三级 WBS（子项目 → 任务 / 里程碑），之后才能用于创建项目。"
            action={canEdit
              ? <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate(`/templates/${template.id}/edit`)}>开始编辑结构</Button>
              : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {subs.map((sub) => (
            <SubProjectTable key={sub.id} sub={sub} />
          ))}
        </div>
      )}
    </div>
  )
}

function SubProjectTable({ sub }: { sub: TemplateNode }) {
  const tasks = sub.children || []
  const milestoneCount = tasks.filter((t) => t.isMilestone).length
  const effort = tasks.reduce((s, t) => s + (t.defaultEffort || 0), 0)
  const cost = tasks.reduce((s, t) => s + (t.costBudget || 0), 0)

  return (
    <Card className="overflow-hidden">
      {/* 子项目头 */}
      <div className="px-4 py-2.5 bg-purple-50 border-b border-purple-200 flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-purple-200 text-purple-800">Lv2</span>
        <span className="text-sm font-semibold text-ink-900">{sub.name}</span>
        {sub.module && <Tag tone="gray">{sub.module}</Tag>}
        {sub.stage && <Tag tone="blue">{sub.stage}</Tag>}
        <span className="text-xs text-ink-500 ml-auto">
          {tasks.length} 任务 · {milestoneCount} 里程碑 · {effort} 人天 · {cost} 万
        </span>
      </div>

      {/* 任务表 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-100 text-ink-700 text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-medium w-8"></th>
              <th className="px-3 py-2 text-left font-medium">代码</th>
              <th className="px-3 py-2 text-left font-medium">任务名称</th>
              <th className="px-3 py-2 text-left font-medium">阶段</th>
              <th className="px-3 py-2 text-right font-medium">工期</th>
              <th className="px-3 py-2 text-right font-medium">工时</th>
              <th className="px-3 py-2 text-left font-medium">负责组</th>
              <th className="px-3 py-2 text-left font-medium">CTD</th>
              <th className="px-3 py-2 text-right font-medium">成本(万)</th>
              <th className="px-3 py-2 text-center font-medium">标记</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function TaskRow({ task }: { task: TemplateNode }) {
  const [open, setOpen] = useState(false)
  const hasDetail = !!(task.description || task.output || task.regulatoryRef || (task.predecessors && task.predecessors.length) || (task.collaborators && task.collaborators.length) || task.milestoneLabel)

  return (
    <>
      <tr
        className={cn('border-b border-ink-300/40 hover:bg-ink-100/40', hasDetail && 'cursor-pointer')}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <td className="px-3 py-2 text-ink-500">
          {hasDetail && (open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)}
        </td>
        <td className="px-3 py-2 font-mono text-xs text-ink-500 whitespace-nowrap">{task.taskCode}</td>
        <td className="px-3 py-2">
          <span className={cn(task.isMilestone && 'font-semibold')}>{task.name}</span>
        </td>
        <td className="px-3 py-2">{task.stage && <Tag tone="blue">{task.stage}</Tag>}</td>
        <td className="px-3 py-2 text-right tabular-nums text-ink-700">{task.isMilestone ? '—' : `${task.defaultDuration ?? 0}d`}</td>
        <td className="px-3 py-2 text-right tabular-nums text-ink-700">{task.isMilestone ? '—' : (task.defaultEffort ?? 0)}</td>
        <td className="px-3 py-2 text-ink-700 whitespace-nowrap">{task.defaultRole || '—'}</td>
        <td className="px-3 py-2 font-mono text-xs text-ink-500 whitespace-nowrap">{task.ctdSection || '—'}</td>
        <td className="px-3 py-2 text-right tabular-nums text-ink-700">{task.costBudget ?? '—'}</td>
        <td className="px-3 py-2">
          <div className="flex items-center justify-center gap-1.5">
            {task.isMilestone && <Diamond className="w-3.5 h-3.5 text-amber-600" />}
            {task.isCriticalPath && <Flame className="w-3.5 h-3.5 text-rose-500" />}
          </div>
        </td>
      </tr>
      {open && hasDetail && (
        <tr className="bg-ink-100/40 border-b border-ink-300/40">
          <td></td>
          <td colSpan={9} className="px-3 py-3">
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              {task.description && <Detail term="描述" desc={task.description} />}
              {task.output && <Detail term="输出物" desc={task.output} />}
              {task.regulatoryRef && <Detail term="监管依据" desc={task.regulatoryRef} />}
              {task.milestoneLabel && <Detail term="里程碑" desc={task.milestoneLabel} />}
              {task.collaborators && task.collaborators.length > 0 && (
                <Detail term="协作组" desc={task.collaborators.join('、')} />
              )}
              {task.predecessors && task.predecessors.length > 0 && (
                <Detail term="前置依赖" desc={task.predecessors.map((p) => `${p.taskCode} (${p.type}${p.lagDays ? `+${p.lagDays}d` : ''})`).join('、')} />
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

function Detail({ term, desc }: { term: string; desc: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-ink-500 shrink-0 w-16">{term}</dt>
      <dd className="text-ink-700 flex-1">{desc}</dd>
    </div>
  )
}

function Stat({ label, value, icon }: { label: string; value: number | string; icon?: React.ReactNode }) {
  return (
    <div className="bg-ink-100/60 rounded-md py-2">
      <div className="text-base font-semibold text-ink-900 leading-none">{value}</div>
      <div className="text-[10px] text-ink-500 mt-1 flex items-center justify-center gap-1">
        {icon}{label}
      </div>
    </div>
  )
}

function sumCost(node: TemplateNode): number {
  let c = node.costBudget || 0
  node.children?.forEach((ch) => { c += sumCost(ch) })
  return c
}
