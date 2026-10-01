import { ArrowLeft, Calendar, FileText, User } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import type { Project } from '../../types'
import { Card, HealthTag, Tag, Avatar } from '../ui'
import { findUser, templates as allTemplates } from '../../mock'
import { getProjectSummary } from '../../lib/analytics'
import { cn } from '../../lib/cn'
import { DeleteProjectButton } from './DeleteProjectButton'

export function ProjectHeader({ project }: { project: Project }) {
  const navigate = useNavigate()
  const owner = findUser(project.ownerId)
  const summary = getProjectSummary(project)
  const template = allTemplates.find((t) => t.id === project.templateId)

  return (
    <Card className="p-5">
      {/* 返回 + 删除（仅系统管理员 / CMC 负责人可见） */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <Link to="/projects" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900">
          <ArrowLeft className="w-3 h-3" /> 返回项目列表
        </Link>
        <DeleteProjectButton project={project} onDeleted={() => navigate('/projects', { replace: true })} />
      </div>

      <div className="flex items-start gap-6">
        {/* 主体信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-ink-500">{project.code}</span>
            <HealthTag health={project.health} />
            <Tag tone={project.status === '活跃' ? 'green' : 'gray'}>{project.status}</Tag>
          </div>
          <h1 className="text-2xl font-semibold text-ink-900 mb-2">{project.name}</h1>
          {project.description && (
            <p className="text-sm text-ink-700 mb-3">{project.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Tag tone="gray">{project.productType}</Tag>
            <Tag tone="blue">当前 · {project.currentStage}</Tag>
            <Tag tone="purple">目标 · {project.targetStage}</Tag>
            {template && (
              <Tag tone="gray" className="gap-1">
                <FileText className="w-3 h-3" />
                {template.name} {project.templateVersion}
              </Tag>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-ink-500">
            {owner && (
              <div className="flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" />
                <span>负责人</span>
                <Avatar user={owner} size="sm" />
                <span className="text-ink-900 font-medium">{owner.displayName}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              <span>{project.plannedStart} → {project.plannedEnd}</span>
            </div>
          </div>
        </div>

        {/* 进度环 */}
        <ProgressRing percent={project.progress} health={project.health} />

        {/* KPI 列 */}
        <div className="hidden lg:grid grid-cols-2 gap-3 w-56">
          <KpiBlock label="总任务" value={summary.taskCount} tone="blue" />
          <KpiBlock label="已完成" value={summary.doneCount} tone="green" />
          <KpiBlock label="关键路径" value={summary.criticalPathCount} tone="red" />
          <KpiBlock label="延迟" value={summary.delayedCount} tone={summary.delayedCount > 0 ? 'red' : 'gray'} />
        </div>
      </div>
    </Card>
  )
}

function ProgressRing({ percent, health }: { percent: number; health: 'green' | 'yellow' | 'red' }) {
  const r = 38
  const c = 2 * Math.PI * r
  const offset = c - (percent / 100) * c
  const colorClass = health === 'red' ? 'stroke-red-500' : health === 'yellow' ? 'stroke-amber-500' : 'stroke-emerald-500'
  return (
    <div className="relative shrink-0 w-24 h-24" aria-label={`进度 ${percent}%`}>
      <svg className="-rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} className="fill-none stroke-ink-100" strokeWidth="8" />
        <circle
          cx="50" cy="50" r={r}
          strokeWidth="8" strokeLinecap="round"
          className={cn('fill-none transition-all', colorClass)}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold text-ink-900 leading-none">{percent}</span>
        <span className="text-xs text-ink-500 mt-1">%</span>
      </div>
    </div>
  )
}

function KpiBlock({ label, value, tone }: { label: string; value: number; tone: 'blue' | 'green' | 'red' | 'gray' }) {
  const map = {
    blue: 'bg-brand-50 text-brand-700',
    green: 'bg-emerald-50 text-emerald-700',
    red: 'bg-red-50 text-red-700',
    gray: 'bg-ink-100 text-ink-700',
  }
  return (
    <div className={cn('px-3 py-2 rounded-md', map[tone])}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-xl font-semibold leading-tight">{value}</div>
    </div>
  )
}
