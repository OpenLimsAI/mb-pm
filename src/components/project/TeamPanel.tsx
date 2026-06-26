// 项目团队面板 — 区分四类身份：
//   1. 项目负责人 (project owner)
//   2. 项目团队成员 (project member — Project.memberIds)
//   3. 任务执行者 (task owner — 出现在任务 ownerId/collaboratorIds 但非以上两类)
//   4. （可选展示）只在团队但无任务的成员

import { useState } from 'react'
import { UserCog } from 'lucide-react'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Tag, Avatar, Button } from '../ui'
import { getProjectTasks, findUser, calcWorkload } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { cn } from '../../lib/cn'
import { ProjectMembersDrawer } from './ProjectMembersDrawer'

type RoleInProject = 'owner' | 'member' | 'task_only'

const roleMeta: Record<RoleInProject, { label: string; tone: 'blue' | 'purple' | 'gray' }> = {
  owner:     { label: '项目负责人',   tone: 'blue' },
  member:    { label: '项目团队成员', tone: 'purple' },
  task_only: { label: '任务执行者',   tone: 'gray' },
}

export function TeamPanel({ project }: { project: Project }) {
  // 订阅数据版本：成员更改保存后刷新本面板
  useDataStore((s) => s.version)
  const currentUser = useAuth((s) => s.currentUser)
  const role = currentUser?.role
  // 编辑权限：admin / cmc_lead 或 项目负责人（与后端 PUT /members 鉴权一致）
  const canEditTeam = role === 'admin' || role === 'cmc_lead' || currentUser?.id === project.ownerId
  const [editOpen, setEditOpen] = useState(false)

  const tasks = getProjectTasks(project.id)
  const memberSet = new Set(project.memberIds || [])

  // 收集所有人员 + 标记其在项目中的身份
  const userRoleMap = new Map<string, RoleInProject>()
  userRoleMap.set(project.ownerId, 'owner')
  memberSet.forEach((id) => {
    if (!userRoleMap.has(id)) userRoleMap.set(id, 'member')
  })
  tasks.forEach((t) => {
    if (!userRoleMap.has(t.ownerId)) userRoleMap.set(t.ownerId, 'task_only')
    t.collaboratorIds?.forEach((id) => {
      if (!userRoleMap.has(id)) userRoleMap.set(id, 'task_only')
    })
  })

  const members = Array.from(userRoleMap.entries())
    .map(([id, roleInProject]) => {
      const u = findUser(id)
      if (!u) return null
      const w = calcWorkload(id)
      const myTasks = tasks.filter((t) => t.ownerId === id)
      return {
        user: u,
        roleInProject,
        workload: w,
        taskCount: myTasks.length,
        doneCount: myTasks.filter((t) => t.status === '已完成' || t.status === '已验证').length,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => {
      // 排序：负责人 → 团队成员（按任务数倒序）→ 任务执行者（按任务数倒序）
      const ord: Record<RoleInProject, number> = { owner: 0, member: 1, task_only: 2 }
      if (ord[a.roleInProject] !== ord[b.roleInProject]) return ord[a.roleInProject] - ord[b.roleInProject]
      return b.taskCount - a.taskCount
    })

  // 统计
  const ownerCount = 1
  const memberCount = members.filter((m) => m.roleInProject === 'member').length
  const taskOnlyCount = members.filter((m) => m.roleInProject === 'task_only').length

  return (
    <Card>
      <CardHeader
        title="项目团队"
        subtitle={
          <span className="flex items-center gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-brand-500" />
              负责人 {ownerCount}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-purple-500" />
              团队成员 {memberCount}
            </span>
            {taskOnlyCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-ink-300" />
                其他任务执行者 {taskOnlyCount}
              </span>
            )}
            <span className="text-ink-500">· 共 {members.length} 人</span>
          </span>
        }
        action={
          canEditTeam && (
            <Button size="sm" variant="secondary" icon={<UserCog className="w-3.5 h-3.5" />} onClick={() => setEditOpen(true)}>
              管理成员
            </Button>
          )
        }
      />
      <CardBody className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-ink-300/40">
          {members.map((m) => {
            const level = m.workload.rate <= 70 ? 'low' : m.workload.rate <= 90 ? 'mid' : 'high'
            const meta = roleMeta[m.roleInProject]
            const isOwner = m.roleInProject === 'owner'
            const isMember = m.roleInProject === 'member'
            return (
              <div
                key={m.user.id}
                className={cn(
                  'bg-white p-3 flex items-center gap-3 border-l-4',
                  isOwner ? 'border-l-brand-500' :
                  isMember ? 'border-l-purple-400' :
                  'border-l-transparent'
                )}
              >
                <Avatar user={m.user} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-ink-900">{m.user.displayName}</span>
                    <Tag tone={meta.tone}>{meta.label}</Tag>
                  </div>
                  <div className="text-xs text-ink-500 mt-0.5">
                    {m.user.specialtyGroup ? `${m.user.specialtyGroup}` : '—'}
                    {m.taskCount > 0 ? ` · ${m.taskCount} 任务，已完成 ${m.doneCount}` : ' · 暂无分配任务'}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-ink-100 rounded">
                      <div
                        className={cn(
                          'h-full rounded',
                          level === 'high' && 'bg-red-500',
                          level === 'mid' && 'bg-amber-500',
                          level === 'low' && 'bg-emerald-500'
                        )}
                        style={{ width: `${Math.min(100, m.workload.rate)}%` }}
                      />
                    </div>
                    <span className={cn(
                      'text-[11px] font-mono w-10 text-right',
                      level === 'high' && 'text-red-600',
                      level === 'mid' && 'text-amber-600',
                      level === 'low' && 'text-emerald-600'
                    )}>{m.workload.rate}%</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardBody>

      {editOpen && (
        <ProjectMembersDrawer project={project} onClose={() => setEditOpen(false)} />
      )}
    </Card>
  )
}
