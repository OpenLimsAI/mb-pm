import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, ClipboardList, Diamond } from 'lucide-react'
import type { Project } from '../../types'
import { findUser } from '../../mock'
import { StatusTag } from '../ui'
import { workbenchGroups, type ProjectItem } from '../../lib/projectWorkbench'
import { recentProjectIds, type ProjectNavigation, type WorkbenchQueue } from '../../lib/projectNavigation'

interface Props {
  projects: Project[]
  items: ProjectItem[]
  userId: string
  navigation: ProjectNavigation
  onChange: (patch: Partial<ProjectNavigation>) => void
  onOpenTask: (id: string) => void
}
const queueNames = { attention: '需要关注', upcoming: '即将到期', milestones: '到期里程碑' }

export function ProjectWorkspace({ projects, items, userId, navigation, onChange, onOpenTask }: Props) {
  const { ownerScope, horizon } = navigation
  const groups = workbenchGroups(items, horizon, ownerScope === 'mine' ? userId : undefined)
  const queue = navigation.queue === 'auto' ? groups.attention.length ? 'attention' : groups.upcoming.length ? 'upcoming' : groups.milestones.length ? 'milestones' : 'attention' : navigation.queue
  const recent = recentProjectIds(userId).flatMap((id) => projects.find((p) => p.id === id) ?? [])
  const shortcuts = (recent.length ? recent : projects).slice(0, 4)
  return <section className="project-workbench" aria-label="跨项目工作台">
    <div className="project-section-heading"><h2>{recent.length ? '最近访问' : '项目快捷入口'}</h2><button type="button" onClick={() => onChange({ page: 'projects' })} className="project-text-link">全部项目 <ArrowRight size={14} /></button></div>
    {shortcuts.length ? <div className="project-shortcuts">{shortcuts.map((p) => <Link key={p.id} to={`/projects/${p.id}`}><span>{p.name}</span><ArrowUpRight size={14} /></Link>)}</div> : <p className="project-empty">暂无活跃项目，可在全部项目中查看其他状态。</p>}
    <div className="project-section-heading project-workbench-controls"><div><h2>项目事项</h2><p>{projects.length} 个可见活跃项目 · {ownerScope === 'mine' ? '仅我负责的任务' : '团队全部负责人'}</p></div><div className="project-control-row"><div className="project-view-switcher" role="group" aria-label="事项负责人">{(['team', 'mine'] as const).map((scope) => <button type="button" key={scope} aria-pressed={ownerScope === scope} onClick={() => onChange({ ownerScope: scope })}>{scope === 'team' ? '团队事项' : '我的事项'}</button>)}</div><select aria-label="事项时间范围" value={horizon} onChange={(e) => onChange({ horizon: Number(e.target.value) as 7 | 30 })}><option value={7}>未来 7 天</option><option value={30}>未来 30 天</option></select></div></div>
    <div className="project-action-summary" role="group" aria-label="事项类别">{(Object.keys(queueNames) as WorkbenchQueue[]).map((key) => <button type="button" key={key} aria-pressed={queue === key} onClick={() => onChange({ queue: key })}><span>{queueNames[key]}<small>{key === 'attention' ? '逾期 / 延迟 / 阻塞' : `含今天 · 未来 ${horizon} 天`}</small></span><strong>{groups[key].length}</strong></button>)}</div>
    <div className="project-workbench-grid"><section className="project-action-panel"><header><h3>{queueNames[queue]}</h3><span>{queue === 'attention' ? '逾期优先 · 全部未完成' : `按截止日期 · 未来 ${horizon} 天`}</span></header><ActionList key={`${queue}-${ownerScope}-${horizon}`} items={groups[queue]} onOpenTask={onOpenTask} empty={queue === 'attention' ? '暂无逾期、延迟或阻塞事项' : '此时间范围内暂无到期事项'} /></section><section className="project-action-panel"><header><h3>近期里程碑</h3><span>未来 {horizon} 天</span></header><ActionList key={`${ownerScope}-${horizon}`} items={groups.milestones} onOpenTask={onOpenTask} empty="此时间范围内暂无里程碑" milestone /></section></div>
    <p className="project-workbench-note">逾期、延迟和阻塞不受未来时间范围限制；已完成、已验证及非活跃项目的事项不计入。</p>
  </section>
}

function ActionList({ items, onOpenTask, empty, milestone = false }: { items: ProjectItem[]; onOpenTask: (id: string) => void; empty: string; milestone?: boolean }) {
  const [limit, setLimit] = useState(milestone ? 5 : 8)
  if (!items.length) return <p className="project-empty">{empty}</p>
  return <><ul className="project-action-list">{items.slice(0, limit).map(({ task, project, days, reason }) => <li key={task.id}>
    <div className="project-action-main"><button type="button" onClick={() => onOpenTask(task.id)} className="project-action-name">{task.isMilestone ? <Diamond size={16} /> : <ClipboardList size={16} />}<span>{task.name}</span></button><div className="project-action-meta"><Link to={`/projects/${project.id}`}>{project.code} · {project.name}</Link><span>{findUser(task.ownerId)?.displayName || '未指定负责人'}</span><StatusTag status={task.status} /></div>{reason && <p className="project-action-reason">{reason}</p>}</div>
    <div className="project-action-side"><span>{days === null ? '未排期' : `${task.plannedEnd} 截止`}</span><button type="button" className="project-text-link" aria-label={`打开任务：${task.name}`} onClick={() => onOpenTask(task.id)}>打开 <ArrowUpRight size={14} /></button></div>
  </li>)}</ul>{items.length > limit && <button type="button" className="project-load-more" onClick={() => setLimit(limit + 10)}>显示更多（剩余 {items.length - limit} 项）</button>}</>
}
