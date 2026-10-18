// 项目团队面板 — 区分身份：
//   1. 项目负责人 (project owner)
//   2. 项目团队成员 (project member — Project.memberIds)
//   3. 任务执行者 (出现在任务 ownerId/collaboratorIds 但非以上两类；任务只能派给团队成员，
//      后端启动时已把这类人补入团队，正常不会出现)

import { useState } from 'react'
import { UserCog, UserMinus, AlertTriangle, Loader2, X } from 'lucide-react'
import type { Project } from '../../types'
import { Card, CardHeader, CardBody, Tag, Avatar, Button } from '../ui'
import { getProjectTasks, findUser, calcWorkload } from '../../mock'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { updateProjectMembers } from '../../data/bootstrap'
import { rejectionText } from '../../api/client'
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
  // 单个成员移除：确认 / 受阻（仍有任务） / 进行中 / 错误
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [blockedId, setBlockedId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const removeMember = async (id: string) => {
    setRemovingId(id)
    setRemoveError(null)
    try {
      const next = (project.memberIds || []).filter((m) => m !== id)
      await updateProjectMembers(project.id, next)
      setConfirmId(null)
    } catch (e) {
      console.error(e)
      setRemoveError(rejectionText(e, '移除失败，请确认后端已启动后重试。'))
    } finally {
      setRemovingId(null)
    }
  }

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
      // 负责或协作的任务都算：仍有任务的人不能移出团队
      const assignedCount = tasks.filter((t) => t.ownerId === id || t.collaboratorIds?.includes(id)).length
      return {
        user: u,
        roleInProject,
        workload: w,
        taskCount: myTasks.length,
        assignedCount,
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
            // 仅项目团队成员可在此移除；负责人由项目设置维护、任务执行者不在团队名单内
            const removable = canEditTeam && isMember
            return (
              <div
                key={m.user.id}
                className={cn(
                  'bg-white border-l-4',
                  isOwner ? 'border-l-brand-500' :
                  isMember ? 'border-l-purple-400' :
                  'border-l-transparent'
                )}
              >
                <div className="p-3 flex items-center gap-3">
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
                  {removable && (
                    <button
                      onClick={() => {
                        setRemoveError(null)
                        if (m.assignedCount > 0) { setBlockedId(m.user.id); setConfirmId(null) }
                        else { setConfirmId(m.user.id); setBlockedId(null) }
                      }}
                      className="shrink-0 p-1.5 rounded-md text-ink-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      title="移出项目团队"
                      aria-label={`移除 ${m.user.displayName}`}
                    >
                      <UserMinus className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* 受阻提示：成员仍有任务，需先转交负责人 */}
                {blockedId === m.user.id && (
                  <div className="px-3 pb-3 -mt-0.5">
                    <div className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        Ta 仍负责或协作本项目 <b>{m.assignedCount}</b> 个任务，无法移除。请先在 <b>WBS</b> 中将这些任务转交他人后再移除。
                      </div>
                      <button onClick={() => setBlockedId(null)} className="shrink-0 text-amber-600 hover:text-amber-900" aria-label="关闭">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {/* 确认移除 */}
                {confirmId === m.user.id && (
                  <div className="px-3 pb-3 -mt-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] bg-ink-50 border border-ink-200 rounded-md px-2.5 py-2">
                      <span className="flex-1 min-w-[140px] text-ink-700">
                        确认将 <b className="text-ink-900">{m.user.displayName}</b> 移出项目团队？
                      </span>
                      {removeError && (
                        <span className="text-red-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{removeError}</span>
                      )}
                      <button
                        onClick={() => removeMember(m.user.id)}
                        disabled={removingId === m.user.id}
                        className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 flex items-center gap-1"
                      >
                        {removingId === m.user.id && <Loader2 className="w-3 h-3 animate-spin" />}
                        确认移除
                      </button>
                      <button
                        onClick={() => { setConfirmId(null); setRemoveError(null) }}
                        disabled={removingId === m.user.id}
                        className="px-2 py-1 rounded border border-ink-300 text-ink-600 hover:bg-ink-100 disabled:opacity-60"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
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
