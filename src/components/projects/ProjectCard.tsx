import { Link } from 'react-router-dom'
import { Calendar, Diamond, Flame } from 'lucide-react'
import type { Project } from '../../types'
import { Card, HealthTag, Tag, Avatar } from '../ui'
import { findUser } from '../../mock'
import { getProjectSummary } from '../../lib/analytics'
import { cn } from '../../lib/cn'

export function ProjectCard({ project }: { project: Project }) {
  const owner = findUser(project.ownerId)
  const s = getProjectSummary(project)

  return (
    <Link
      to={`/projects/${project.id}`}
      className="block transition-shadow hover:shadow-card-hover"
    >
      <Card className="p-4 h-full flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-mono text-ink-500">{project.code}</span>
              <HealthTag health={project.health} />
              {project.status !== '活跃' && <Tag tone="gray">{project.status}</Tag>}
            </div>
            <div className="text-base font-semibold text-ink-900 leading-tight" title={project.name}>
              {project.name}
            </div>
          </div>
        </div>

        {project.description && (
          <p className="text-xs text-ink-500 mb-3 line-clamp-2">{project.description}</p>
        )}

        <div className="flex flex-wrap gap-1 mb-3">
          <Tag tone="gray">{project.productType}</Tag>
          <Tag tone="blue">{project.currentStage}</Tag>
          <Tag tone="purple">→ {project.targetStage}</Tag>
        </div>

        {/* 进度 */}
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-ink-500">总进度</span>
            <span className="font-semibold">{project.progress}%</span>
          </div>
          <div className="h-2 bg-ink-100 rounded overflow-hidden">
            <div
              className={cn(
                'h-full rounded',
                project.health === 'red' && 'bg-red-500',
                project.health === 'yellow' && 'bg-amber-500',
                project.health === 'green' && 'bg-emerald-500'
              )}
              style={{ width: `${project.progress}%` }}
            />
          </div>
        </div>

        {/* 关键指标 */}
        <div className="grid grid-cols-3 gap-2 mb-3 text-center text-xs">
          <div className="p-2 bg-ink-100 rounded">
            <div className="text-base font-semibold text-ink-900">{s.taskCount}</div>
            <div className="text-[10px] text-ink-500">总任务</div>
          </div>
          <div className="p-2 bg-emerald-50 rounded">
            <div className="text-base font-semibold text-emerald-700">{s.doneCount}</div>
            <div className="text-[10px] text-ink-500">已完成</div>
          </div>
          <div className={cn('p-2 rounded', s.delayedCount > 0 ? 'bg-red-50' : 'bg-ink-100')}>
            <div className={cn('text-base font-semibold', s.delayedCount > 0 ? 'text-red-700' : 'text-ink-900')}>
              {s.delayedCount}
            </div>
            <div className="text-[10px] text-ink-500">延迟/阻塞</div>
          </div>
        </div>

        {/* 即将到来的里程碑 */}
        {s.upcomingMilestone && (
          <div className={cn(
            'flex items-center gap-2 px-2.5 py-1.5 rounded-md mb-3 text-xs',
            s.upcomingMilestone.daysLeft < 14
              ? 'bg-amber-50 text-amber-700'
              : 'bg-brand-50 text-brand-700'
          )}>
            <Diamond className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 truncate">{s.upcomingMilestone.name}</span>
            <span className="font-medium">
              {s.upcomingMilestone.daysLeft >= 0
                ? `${s.upcomingMilestone.daysLeft}天后`
                : `逾期${-s.upcomingMilestone.daysLeft}天`}
            </span>
          </div>
        )}

        {/* Footer */}
        <div className="mt-auto pt-3 border-t border-ink-300/40 flex items-center justify-between text-[11px] text-ink-500">
          <div className="flex items-center gap-1.5">
            {owner && <Avatar user={owner} size="sm" />}
            <span>{owner?.displayName}</span>
          </div>
          <div className="flex items-center gap-3">
            {s.criticalPathCount > 0 && (
              <span className="flex items-center gap-1" title="关键路径任务数">
                <Flame className="w-3 h-3 text-red-500" />
                {s.criticalPathCount}
              </span>
            )}
            <span className="flex items-center gap-1" title="计划时间">
              <Calendar className="w-3 h-3" />
              {project.plannedEnd}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  )
}
