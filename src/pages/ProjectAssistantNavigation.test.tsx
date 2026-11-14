import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import ProjectDetail from './ProjectDetail'
import Finance from './Finance'
import { projects, users } from '../mock'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
vi.mock('../components/project/ProjectHeader', () => ({ ProjectHeader: () => null }))
vi.mock('../components/project/WBSTree', () => ({ WBSTree: () => null }))
vi.mock('../components/project/WBSTable', () => ({ WBSTable: () => null }))
vi.mock('../components/project/Gantt', () => ({ Gantt: () => null }))
vi.mock('../components/project/WbsWorkspace', () => ({ WbsWorkspace: () => null }))
vi.mock('../components/project/MilestonePanel', () => ({ MilestonePanel: () => null }))
vi.mock('../components/project/MilestoneTimeline', () => ({ MilestoneTimeline: () => null }))
vi.mock('../components/project/ProjectBudgetCard', () => ({ ProjectBudgetCard: () => null }))
vi.mock('../components/project/BaselinePanel', () => ({ BaselinePanel: () => null }))
vi.mock('../components/project/DelayImpact', () => ({ DelayImpact: () => null }))
vi.mock('../components/project/ProjectExchange', () => ({ ProjectExchange: () => null }))
vi.mock('../components/project/TemplateUpgrade', () => ({ TemplateUpgrade: () => null }))
vi.mock('../components/project/ProgressPolicy', () => ({ ProgressPolicy: () => null }))
vi.mock('../components/project/TeamPanel', () => ({ TeamPanel: () => null }))
vi.mock('../components/project/ProjectStructureEditor', () => ({ ProjectStructureEditor: () => null }))
vi.mock('../components/management/PMManagement', () => ({ PMManagement: () => null }))
vi.mock('../components/task/TaskDrawer', () => ({ TaskDrawer: () => null }))
vi.mock('../components/project/PMAssistant', () => ({ PMAssistant: ({ projectId }: { projectId: string }) => <div>统一项目助手 {projectId}</div> }))
vi.mock('../data/bootstrap', () => ({ refreshAllData: vi.fn() }))
function Location() { const location = useLocation(); return <output aria-label="当前位置">{location.pathname}{location.search}</output> }
beforeEach(() => {
  useAuth.setState({ currentUser: users.find(user => user.role === 'admin')!, status: 'ready' })
  useDataStore.setState({ mode: 'api', ready: true })
})
test('项目详情移除独立 AI 分析页签，旧链接保留核对和任务参数后进入统一助手', async () => {
  const project = projects[0]
  render(<MemoryRouter initialEntries={[`/projects/${project.id}?tab=ai&agent_proposal=proposal-1&task=existing`]}><Routes>
    <Route path="/projects/:id" element={<><Location /><ProjectDetail /></>} />
  </Routes></MemoryRouter>)
  expect(screen.queryByRole('button', { name: 'AI 分析' })).not.toBeInTheDocument()
  expect(screen.getByText(`统一项目助手 ${project.id}`)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('assistant=proposal'))
  expect(screen.getByLabelText('当前位置')).toHaveTextContent('agent_proposal=proposal-1&task=existing')
  expect(screen.getByLabelText('当前位置')).not.toHaveTextContent('tab=ai')
})
test('旧财务 AI 页签跳转统一助手的组合财务', async () => {
  render(<MemoryRouter initialEntries={['/finance?tab=ai']}><Routes>
    <Route path="/finance" element={<Finance />} />
    <Route path="/project-assistant" element={<Location />} />
  </Routes></MemoryRouter>)
  expect(await screen.findByLabelText('当前位置')).toHaveTextContent('/project-assistant?assistant=finance')
})
