import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  LayoutGrid, Diamond, FolderTree, Users, Flag, Zap, Sparkles,
  CheckCircle2, X,
} from 'lucide-react'
import { findProject, findTask, subProjects } from '../mock'
import { useDataStore } from '../store/data'
import { useAuth } from '../store/auth'
import { can } from '../lib/permissions'
import { ProjectHeader } from '../components/project/ProjectHeader'
import { WBSTree } from '../components/project/WBSTree'
import { WBSTable } from '../components/project/WBSTable'
import { Gantt } from '../components/project/Gantt'
import { WbsWorkspace, type WbsView } from '../components/project/WbsWorkspace'
import { MilestonePanel } from '../components/project/MilestonePanel'
import { MilestoneTimeline } from '../components/project/MilestoneTimeline'
import { ProjectBudgetCard } from '../components/project/ProjectBudgetCard'
import { BaselinePanel } from '../components/project/BaselinePanel'
import { PMManagement } from '../components/management/PMManagement'
import { DelayImpact } from '../components/project/DelayImpact'
import { ProjectAIAnalysis } from '../components/project/ProjectAIAnalysis'
import { TeamPanel } from '../components/project/TeamPanel'
import { ProjectStructureEditor } from '../components/project/ProjectStructureEditor'
import { TaskDrawer } from '../components/task/TaskDrawer'
import { EmptyState } from '../components/ui'
import { cn } from '../lib/cn'
import { recordProjectVisit } from '../lib/projectNavigation'
import { getProjectMDMLaunchUrl } from '../api/projects'

// Tab 顺序：概览 → 里程碑 → WBS → 延迟推演 → 基线 → 团队 → AI 分析（仅管理者）
type Tab = 'overview' | 'milestones' | 'wbs' | 'delay' | 'baseline' | 'team' | 'ai' | 'management'
// WBS 子视图：表格（行内编辑，主工作面）/ 树形 / 甘特图

export default function ProjectDetail() {
  const [params, setParams] = useSearchParams()
  const { id } = useParams<{ id: string }>()
  const role = useAuth((s) => s.currentUser?.role)
  const userId = useAuth((s) => s.currentUser?.id) ?? 'offline'
  const canAnalyze = can(role, 'ai.analyze')
  // 「编辑项目」（项目信息、预算、子项目 / 任务 / 依赖）：与账号管理身份对应；后端另按项目可见范围校验
  const canEditProject = can(role, 'project.edit')
  // 订阅数据版本：任务进展保存后重算并刷新本页（含抽屉、WBS、里程碑）
  useDataStore((s) => s.version)
  const online = useDataStore((s) => s.mode) === 'api'
  const project = findProject(id || '')
  const requestedTab = params.get('tab')
  const tab: Tab = ['overview', 'milestones', 'wbs', 'delay', 'baseline', 'team', 'ai', 'management'].includes(requestedTab || '') ? requestedTab as Tab : 'overview'
  const setTab = (value: Tab) => { const next = new URLSearchParams(params); next.set('tab', value); setParams(next) }
  const [wbsView, setWbsView] = useState<WbsView>('table')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const requestedTask = params.get('task')
  const drawerTaskId = requestedTask && findTask(requestedTask)?.subProjectId && project && subProjects.some(s => s.id === findTask(requestedTask)?.subProjectId && s.projectId === project.id) ? requestedTask : null
  const setDrawerTaskId = (value: string | null) => { const next = new URLSearchParams(params); if (value) next.set('task', value); else next.delete('task'); setParams(next, { replace: true }) }
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (project) recordProjectVisit(userId, project.id)
  }, [userId, project])

  if (!project) {
    return (
      <div className="p-6">
        <EmptyState title="项目不存在" description={`找不到项目 ID：${id}`} />
      </div>
    )
  }

  // 点击任务 → 同步选中 + 打开抽屉
  const handleSelectTask = (taskId: string) => {
    setSelectedTaskId(taskId)
    setDrawerTaskId(taskId)
  }

  // 「编辑项目」入口在页首（删除项目左侧），进入编辑页：预算 + 项目结构
  const startEditing = canEditProject
    ? () => {
        setNotice(null)
        setDrawerTaskId(null)
        setEditing(true)
      }
    : undefined

  if (editing) {
    return (
      <div className="p-6 max-w-[1600px] mx-auto space-y-4">
        <ProjectHeader project={project} />
        <ProjectStructureEditor
          key={project.id}
          project={project}
          onExit={(message) => {
            setEditing(false)
            if (message) setNotice(message)
          }}
        />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-4">
      <ProjectHeader
        project={project}
        onEdit={startEditing}
        editDisabledReason={online ? undefined : '离线演示模式不支持修改项目'}
      />

      <button type="button" className="px-3 py-2 rounded-lg border text-sm" disabled={!online} onClick={() => {
        void getProjectMDMLaunchUrl(project.id).then((url) => window.location.assign(url)).catch(() => setNotice('无法打开 MDM：请确认入口配置、登录及项目权限。'))
      }}>打开 MDM 登记项目</button>

      {notice && (
        <div role="status" className="p-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="p-0.5 rounded hover:bg-emerald-100" aria-label="关闭提示">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center flex-wrap gap-1 border-b border-ink-300/60 -mb-px">
        <TabBtn current={tab} v="overview"   icon={<LayoutGrid className="w-4 h-4" />}        label="概览" onClick={setTab} />
        <TabBtn current={tab} v="milestones" icon={<Diamond className="w-4 h-4" />}           label="里程碑" onClick={setTab} />
        <TabBtn current={tab} v="wbs"         icon={<FolderTree className="w-4 h-4" />}        label="WBS" onClick={setTab} />
        <TabBtn current={tab} v="delay"       icon={<Zap className="w-4 h-4" />}               label="延迟推演" onClick={setTab} />
        <TabBtn current={tab} v="baseline"    icon={<Flag className="w-4 h-4" />}              label="基线" onClick={setTab} />
        <TabBtn current={tab} v="team"        icon={<Users className="w-4 h-4" />}             label="团队" onClick={setTab} />
        <TabBtn current={tab} v="management" icon={<CheckCircle2 className="w-4 h-4" />} label="项目跟进" onClick={setTab} />
        {canAnalyze && (
          <TabBtn current={tab} v="ai"        icon={<Sparkles className="w-4 h-4" />}          label="AI 分析" onClick={setTab} />
        )}
      </div>

      {/* 概览：里程碑路线图（横向置顶，宏观）→ 预算与成本 → 三级 WBS（下方） */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <MilestoneTimeline project={project} onSelectTask={handleSelectTask} />
          <ProjectBudgetCard project={project} />
          <WBSTree project={project} onSelectTask={handleSelectTask} selectedTaskId={selectedTaskId} />
        </div>
      )}

      {/* 里程碑：达成条件（关联 WBS 任务）+ 设置 */}
      {tab === 'milestones' && (
        <MilestonePanel project={project} onOpenTask={handleSelectTask} />
      )}

      {/* WBS：表格（行内编辑）/ 树形 / 甘特图 */}
      {tab === 'wbs' && (
        <WbsWorkspace key={project.id} view={wbsView} onChange={setWbsView} projectName={project.name}
          overlayOpen={!!drawerTaskId}
          overlay={<TaskDrawer task={drawerTaskId ? findTask(drawerTaskId) || null : null} onClose={() => setDrawerTaskId(null)} />}>
          {(fullscreen) => (
            <>
              {wbsView === 'table' && <WBSTable project={project} onOpenTask={handleSelectTask} selectedTaskId={selectedTaskId} fillHeight={fullscreen} />}
              {wbsView === 'tree' && <WBSTree project={project} onSelectTask={handleSelectTask} selectedTaskId={selectedTaskId} highlightCriticalPath fillHeight={fullscreen} />}
              {wbsView === 'gantt' && <Gantt project={project} selectedTaskId={selectedTaskId} onSelectTask={handleSelectTask} fillHeight={fullscreen} />}
            </>
          )}
        </WbsWorkspace>
      )}

      {tab === 'delay' && <DelayImpact project={project} />}

      {tab === 'baseline' && <BaselinePanel project={project} />}

      {tab === 'management' && <PMManagement project={project} />}

      {tab === 'team' && <TeamPanel project={project} />}

      {tab === 'ai' && canAnalyze && (
        <ProjectAIAnalysis key={project.id} projectId={project.id} projectName={project.name} />
      )}

      {tab !== 'wbs' && <TaskDrawer
        task={drawerTaskId ? findTask(drawerTaskId) || null : null}
        onClose={() => setDrawerTaskId(null)}
      />}
    </div>
  )
}

function TabBtn({
  current, v, icon, label, onClick,
}: { current: Tab; v: Tab; icon: React.ReactNode; label: string; onClick: (v: Tab) => void }) {
  const active = current === v
  return (
    <button
      onClick={() => onClick(v)}
      className={cn(
        'inline-flex items-center gap-2 px-4 py-2 text-sm border-b-2 transition-colors',
        active
          ? 'border-brand-600 text-brand-700 font-medium'
          : 'border-transparent text-ink-700 hover:text-ink-900 hover:bg-ink-100'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
