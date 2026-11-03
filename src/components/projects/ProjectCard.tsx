import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import type { Project } from '../../types'
import type { ProjectItem } from '../../lib/projectWorkbench'
import { HealthTag, Tag } from '../ui'
import { findUser, getProjectSpan } from '../../mock'

export function ProjectCard({ project, items = [] }: { project: Project; items?: ProjectItem[] }) {
  const owner = findUser(project.ownerId)
  const attention = items.filter((item) => item.attention)
  const next = items.find((item) => item.task.isMilestone && item.days !== null && item.days >= 0) ?? items.find((item) => item.days !== null && item.days >= 0)
  return (
    <Link to={`/projects/${project.id}`} className="project-entry" aria-label={`进入项目：${project.name}`}>
      <div className="project-entry-heading"><span className="project-code">{project.code}</span><div className="flex gap-1"><HealthTag health={project.health} />{project.status !== '活跃' && <Tag>{project.status}</Tag>}</div></div>
      <h2>{project.name}</h2>
      <div className="project-entry-meta"><span>{project.productType} · {project.currentStage}</span><span>{owner?.displayName || '未指定负责人'}</span><span>计划 {getProjectSpan(project).end || '未排期'}</span></div>
      <div className="project-entry-progress"><span>整体进度</span><strong>{project.progress}%</strong></div>
      <div className="project-entry-track" role="progressbar" aria-label={`${project.name}整体进度`} aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(0, Math.min(100, project.progress))}%` }} /></div>
      <div className="project-entry-footer"><span className={attention.length ? 'text-amber-700' : ''}>{attention.length ? `${attention.length} 项需关注 · ${attention[0].task.name}` : next ? `${next.task.plannedEnd} · ${next.task.name}` : '暂无未完成的排期事项'}</span><span className="project-entry-open">进入项目 <ArrowUpRight size={14} /></span></div>
    </Link>
  )
}
