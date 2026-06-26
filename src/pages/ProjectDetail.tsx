import { useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  LayoutGrid, Diamond, FolderTree, Users, GanttChartSquare, Rows3, Table2, Flag,
} from 'lucide-react'
import { findProject, findTask } from '../mock'
import { useDataStore } from '../store/data'
import { ProjectHeader } from '../components/project/ProjectHeader'
import { WBSTree } from '../components/project/WBSTree'
import { WBSTable } from '../components/project/WBSTable'
import { Gantt } from '../components/project/Gantt'
import { MilestonePanel } from '../components/project/MilestonePanel'
import { MilestoneTimeline } from '../components/project/MilestoneTimeline'
import { BaselinePanel } from '../components/project/BaselinePanel'
import { TeamPanel } from '../components/project/TeamPanel'
import { TaskDrawer } from '../components/task/TaskDrawer'
import { EmptyState } from '../components/ui'
import { cn } from '../lib/cn'

// Tab 顺序：概览 → 里程碑 → WBS → 基线 → 团队
type Tab = 'overview' | 'milestones' | 'wbs' | 'baseline' | 'team'
// WBS 子视图：表格（行内编辑，主工作面）/ 树形 / 甘特图
type WbsView = 'table' | 'tree' | 'gantt'

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  // 订阅数据版本：任务进展保存后重算并刷新本页（含抽屉、WBS、里程碑）
  useDataStore((s) => s.version)
  const project = findProject(id || '')
  const [tab, setTab] = useState<Tab>('overview')
  const [wbsView, setWbsView] = useState<WbsView>('table')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null)

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

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-4">
      <ProjectHeader project={project} />

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-ink-300/60 -mb-px">
        <TabBtn current={tab} v="overview"   icon={<LayoutGrid className="w-4 h-4" />}        label="概览" onClick={setTab} />
        <TabBtn current={tab} v="milestones" icon={<Diamond className="w-4 h-4" />}           label="里程碑" onClick={setTab} />
        <TabBtn current={tab} v="wbs"         icon={<FolderTree className="w-4 h-4" />}        label="WBS" onClick={setTab} />
        <TabBtn current={tab} v="baseline"    icon={<Flag className="w-4 h-4" />}              label="基线" onClick={setTab} />
        <TabBtn current={tab} v="team"        icon={<Users className="w-4 h-4" />}             label="团队" onClick={setTab} />
      </div>

      {/* 概览：里程碑路线图（横向置顶，宏观）→ 三级 WBS（下方） */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <MilestoneTimeline project={project} onSelectTask={handleSelectTask} />
          <WBSTree project={project} onSelectTask={handleSelectTask} selectedTaskId={selectedTaskId} />
        </div>
      )}

      {/* 里程碑：达成条件（关联 WBS 任务）+ 设置 */}
      {tab === 'milestones' && (
        <MilestonePanel project={project} onOpenTask={handleSelectTask} />
      )}

      {/* WBS：表格（行内编辑）/ 树形 / 甘特图 */}
      {tab === 'wbs' && (
        <div className="space-y-3">
          <WbsViewSwitcher view={wbsView} onChange={setWbsView} />
          {wbsView === 'table' && (
            <WBSTable project={project} onOpenTask={handleSelectTask} selectedTaskId={selectedTaskId} />
          )}
          {wbsView === 'tree' && (
            <WBSTree project={project} onSelectTask={handleSelectTask} selectedTaskId={selectedTaskId} highlightCriticalPath />
          )}
          {wbsView === 'gantt' && (
            <Gantt project={project} selectedTaskId={selectedTaskId} onSelectTask={handleSelectTask} />
          )}
        </div>
      )}

      {tab === 'baseline' && <BaselinePanel project={project} />}

      {tab === 'team' && <TeamPanel project={project} />}

      <TaskDrawer
        task={drawerTaskId ? findTask(drawerTaskId) || null : null}
        onClose={() => setDrawerTaskId(null)}
      />
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

function WbsViewSwitcher({ view, onChange }: { view: WbsView; onChange: (v: WbsView) => void }) {
  const opts: { v: WbsView; label: string; icon: typeof Table2 }[] = [
    { v: 'table', label: '表格录入', icon: Table2 },
    { v: 'tree', label: '树形', icon: Rows3 },
    { v: 'gantt', label: '甘特图', icon: GanttChartSquare },
  ]
  return (
    <div className="flex items-center justify-between">
      <div className="inline-flex rounded-md border border-ink-300 bg-white p-0.5">
        {opts.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors',
              view === o.v ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-700 hover:bg-ink-100',
            )}
          >
            <o.icon className="w-3.5 h-3.5" />
            {o.label}
          </button>
        ))}
      </div>
      <span className="text-xs text-ink-400">
        系统严格三级：项目 → 子项目 → 任务（Lv3 下不可再建子节点）
      </span>
    </div>
  )
}
