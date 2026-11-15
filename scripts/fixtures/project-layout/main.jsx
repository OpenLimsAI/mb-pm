// Development-only fixture: real UI components, synthetic records and no API access.
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import '../../../src/index.css'
import '../../../src/components/ui/workbenchLink.css'
import '../../../src/styles/efficient-workspace.css'
import '../../../src/styles/forest-theme.css'
import '../../../src/styles/forest-applications.css'
import '../../../src/styles/forest-shell.css'
import '../../../src/styles/blue-workspace.css'
import { AppLayout } from '../../../src/components/layout/AppLayout'
import ProjectReadyGate from '../../../src/components/auth/ProjectReadyGate'
import ProjectAssistant from '../../../src/pages/ProjectAssistant'
import GanttPage from '../../../src/pages/Gantt'
import { Gantt } from '../../../src/components/project/Gantt'
import { WbsWorkspace } from '../../../src/components/project/WbsWorkspace'
import { useAuth } from '../../../src/store/auth'
import { useDataStore } from '../../../src/store/data'
import { projects, tasks, subProjects, users, taskDependencies } from '../../../src/mock'
import { pmAI } from '../../../src/api/pmAI'
import { pmManagement } from '../../../src/api/pmManagement'
import { api } from '../../../src/api/client'

const user = { id: 'qa-user', username: 'qa', displayName: '布局验证', role: 'admin', email: '', weeklyAvailableHours: 40, isActive: true, avatarColor: '' }
const project = { id: 'qa-project', code: 'QA-001', name: '合成布局项目', description: '仅用于页面布局核对', ownerId: user.id, productType: '其他', currentStage: '临床前', targetStage: 'IND', status: '活跃', health: 'green', plannedStart: '2026-11-01', plannedEnd: '2027-10-30', progress: 22, templateId: null, templateVersion: null }
users.splice(0, users.length, user)
projects.splice(0, projects.length, project)
subProjects.splice(0, subProjects.length, { id: 'qa-sub', projectId: project.id, name: '合成阶段', stage: '临床前', module: '其他', status: '进行中', progress: 22, sortOrder: 0 })
tasks.splice(0, tasks.length, ...Array.from({ length: 80 }, (_, index) => ({
  id: `qa-task-${index}`, subProjectId: 'qa-sub', code: `QA-${index}`, name: `合成任务 ${index + 1}`,
  ownerId: user.id, status: '进行中', priority: '中', plannedStart: '2026-11-01', plannedEnd: '2027-10-30',
  estimatedEffort: 1, progress: 22, isMilestone: false, isCriticalPath: false,
})))
taskDependencies.splice(0, taskDependencies.length)
useAuth.setState({ currentUser: user, status: 'ready', mustChangePassword: false, refreshError: null })
useDataStore.setState({ mode: 'api', ready: true, businessDate: '2026-11-15', notice: null })
window.__projectLayoutRequests = []
api.defaults.adapter = async config => {
  window.__projectLayoutRequests.push(config.url)
  throw new Error(`Synthetic layout test forbids API: ${config.url}`)
}
const source = { schemaVersion: 1, asOf: '2026-11-15', complete: true, refs: [] }
pmAI.context = async () => ({
  schemaVersion: 1, scope: { projectIds: [project.id], taskIds: [] }, asOf: '2026-11-15', timezone: 'Asia/Singapore',
  projects: [project], tasks: [], members: [], subProjects: [], registerEntries: [], source,
})
pmAI.list = async () => ({ items: [], total: 0 })
pmAI.get = async () => ({
  id: 'qa-run', scenario: 'weekly', state: 'succeeded', createdAt: '2026-11-15T00:00:00Z', error: '', source,
  scope: { projectIds: [project.id], taskIds: [] },
  request: { scenario: 'weekly', projectIds: [project.id], taskIds: [], question: '整理本周项目周报', material: '' },
  result: {
    summary: '这是合成周报，仅用于布局核对。',
    findings: Array.from({ length: 100 }, (_, index) => ({
      title: `第 ${index + 1} 项合成进展`,
      detail: '本段仅用于模拟长报告，核对页面滚动边界及内容折叠之后的留白。'.repeat(4), evidenceIds: [], kind: 'fact',
    })),
    draftActions: [],
  },
})
pmManagement.notifications = async () => ({ mode: 'immediate', asOf: '2026-11-15', unread: 0, badgeCount: 0, digestKeys: [], items: [], truncated: false })

function WbsFixture() {
  const [view, setView] = useState('gantt')
  return <div className="p-6 space-y-4">
    <h1>合成项目 WBS</h1>
    <div style={{ height: 500 }}>项目内容占位，验证进入全屏前滚动位置</div>
    <WbsWorkspace projectName={project.name} view={view} onChange={setView}>
      {fullscreen => <Gantt project={project} fillHeight={fullscreen} />}
    </WbsWorkspace>
  </div>
}
function Controller() {
  const navigate = useNavigate()
  useEffect(() => {
    window.__projectLayout = {
      navigate,
      setNotice: enabled => useDataStore.setState({ notice: enabled ? '合成数据同步提示：当前保留已载入资料，等连接恢复后继续核对，不会自动修改任何项目数据。' : null }),
      setIdentity: enabled => useAuth.setState({ refreshError: enabled ? '合成身份刷新提示：暂时无法确认登录状态，当前页面保留，请重试；需要身份验证的操作可能暂时无法完成。' : null }),
    }
    window.__projectLayoutReady = true
  }, [navigate])
  return null
}
createRoot(document.getElementById('root')).render(<StrictMode>
  <MemoryRouter initialEntries={['/project-assistant']}>
    <Controller />
    <Routes><Route element={<ProjectReadyGate />}><Route element={<AppLayout />}>
      <Route path="/project-assistant" element={<ProjectAssistant />} />
      <Route path="/gantt" element={<GanttPage />} />
      <Route path="/wbs" element={<WbsFixture />} />
    </Route></Route></Routes>
  </MemoryRouter>
</StrictMode>)
