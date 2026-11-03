import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Calendar, Circle, Diamond } from 'lucide-react'
import type { Project } from '../../types'
import { findUser, getProjectSpan, subProjects, tasks } from '../../mock'
import { getProjectSummary } from '../../lib/analytics'
import { cn } from '../../lib/cn'
import { HealthTag, StatusTag, Tag } from '../ui'

/** 项目列表和真实数据摘要保持在同一个工作面，原有完整项目页仍承载编辑等操作。 */
export function ProjectWorkspace({ projects }: { projects: Project[] }) {
  const [selectedId, setSelectedId] = useState<string>()
  const detailId = useId()
  // 筛选、删除或权限数据刷新后，只展示当前列表内的项目，避免保留已不可见的详情。
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0]
  if (!selected) return null

  const owner = findUser(selected.ownerId)
  const summary = getProjectSummary(selected)
  const span = getProjectSpan(selected)
  const subIds = new Set(subProjects.filter((sub) => sub.projectId === selected.id).map((sub) => sub.id))
  const openTasks = tasks.filter((task) => subIds.has(task.subProjectId) && task.status !== '已完成' && task.status !== '已验证')
    .sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd) || a.name.localeCompare(b.name))
  const nextMilestone = openTasks.find((task) => task.isMilestone)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] border border-ink-300/70 rounded-lg bg-white overflow-hidden">
      <section aria-label="项目列表" className="min-w-0">
        <div className="flex justify-between gap-3 px-4 py-3 border-b border-ink-300/60 text-xs text-ink-500">
          <span>项目 / 负责人 / 计划完成</span><span>{projects.length} 个项目</span>
        </div>
        <ul className="divide-y divide-ink-300/50 max-h-80 lg:max-h-[calc(100dvh-300px)] lg:min-h-[360px] overflow-auto">
          {projects.map((project) => {
            const active = project.id === selected.id
            return (
              <li key={project.id}>
                <button
                  type="button"
                  aria-label={`查看 ${project.code} ${project.name}`}
                  aria-pressed={active}
                  aria-controls={detailId}
                  onClick={() => setSelectedId(project.id)}
                  className={cn('w-full text-left px-4 py-4 border-l-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600',
                    active ? 'border-l-brand-600 bg-brand-50' : 'border-l-transparent hover:bg-ink-100/60')}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-xs text-ink-500 mb-1">{project.code}</span>
                      <span className="block text-sm font-medium text-ink-900 break-words">{project.name}</span>
                    </span>
                    <HealthTag health={project.health} />
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500 mt-2">
                    <span>{project.currentStage}</span>
                    <span>{findUser(project.ownerId)?.displayName || '未指定负责人'}</span>
                    <span className="ml-auto tabular-nums">{getProjectSpan(project).end || '未排期'}</span>
                  </span>
                  <span className="flex items-center gap-3 mt-3">
                    <span className="h-1 rounded-full bg-ink-300/40 flex-1 overflow-hidden"><span className="block h-full bg-brand-600 rounded-full" style={{ width: `${Math.max(0, Math.min(100, project.progress))}%` }} /></span>
                    <span className="text-xs text-ink-700 tabular-nums w-9 text-right">{project.progress}%</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section id={detailId} aria-label="选中项目详情" aria-live="polite" className="min-w-0 border-t lg:border-t-0 lg:border-l border-ink-300/70 bg-white p-5">
        <div className="flex items-center justify-between gap-3 text-xs text-ink-500">
          <span>{selected.code}</span><Tag>{selected.status}</Tag>
        </div>
        <h2 className="text-lg font-semibold text-ink-900 mt-3 break-words">{selected.name}</h2>
        {selected.description && <p className="text-xs text-ink-500 leading-relaxed mt-2 break-words">{selected.description}</p>}
        <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-3 text-xs mt-5">
          <dt className="text-ink-500">项目负责人</dt><dd>{owner?.displayName || '未指定'}</dd>
          <dt className="text-ink-500">产品类型</dt><dd>{selected.productType}</dd>
          <dt className="text-ink-500">研发阶段</dt><dd>{selected.currentStage} → {selected.targetStage}</dd>
          <dt className="text-ink-500">计划完成</dt><dd className="tabular-nums">{span.end || '未排期'}</dd>
        </dl>
        <div className="grid grid-cols-3 gap-2 border-y border-ink-300/60 py-4 my-5">
          <div><div className="text-lg font-semibold tabular-nums">{selected.progress}%</div><div className="text-xs text-ink-500 mt-1">整体进度</div></div>
          <div><div className="text-lg font-semibold tabular-nums">{summary.doneCount}/{summary.taskCount}</div><div className="text-xs text-ink-500 mt-1">完成任务</div></div>
          <div><div className={cn('text-lg font-semibold tabular-nums', summary.delayedCount > 0 && 'text-red-700')}>{summary.delayedCount}</div><div className="text-xs text-ink-500 mt-1">延迟 / 阻塞</div></div>
        </div>
        <h3 className="text-sm font-medium text-ink-900">下一里程碑</h3>
        {nextMilestone ? <div className="flex items-start gap-2 text-xs mt-3">
          <Diamond className="w-4 h-4 text-brand-600 shrink-0 mt-0.5" />
          <div className="min-w-0"><p className="break-words">{nextMilestone.name}</p><p className="text-ink-500 tabular-nums mt-1">{nextMilestone.plannedEnd}</p></div>
        </div> : <p className="text-xs text-ink-500 mt-3">暂无未完成里程碑</p>}
        <h3 className="text-sm font-medium text-ink-900 mt-5">近期任务</h3>
        {openTasks.length > 0 ? <ul className="divide-y divide-ink-300/40 mt-1">
          {openTasks.slice(0, 4).map((task) => <li key={task.id} className="py-3">
            <div className="flex items-start gap-2"><Circle className="w-3.5 h-3.5 text-ink-500 shrink-0 mt-0.5" /><span className="text-xs break-words">{task.name}</span></div>
            <div className="flex items-center justify-between gap-2 mt-2 pl-5"><span className="inline-flex items-center gap-1 text-xs text-ink-500 tabular-nums"><Calendar className="w-3 h-3" />{task.plannedEnd}</span><StatusTag status={task.status} /></div>
          </li>)}
        </ul> : <p className="text-xs text-ink-500 mt-3">暂无未完成任务</p>}
        <Link to={`/projects/${selected.id}`} className="inline-flex items-center justify-center gap-2 w-full px-3 py-2 mt-4 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700">
          打开完整项目 <ArrowUpRight className="w-4 h-4" />
        </Link>
      </section>
    </div>
  )
}
