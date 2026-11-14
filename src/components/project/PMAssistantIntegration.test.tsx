import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { PMAssistant } from './PMAssistant'
import ProjectAssistant from '../../pages/ProjectAssistant'
import AISettings from '../../pages/AISettings'
import { pmAI } from '../../api/pmAI'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { findSubProject, projects, tasks, users } from '../../mock'

vi.mock('../../api/pmAI', () => ({ pmAI: { context: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), plan: vi.fn() } }))
vi.mock('./ProjectAIWorkbench', () => ({ ProjectAIWorkbench: ({ projectId, agentReportKey }: { projectId: string; agentReportKey?: string }) => <div>评估范围 {projectId} {agentReportKey}</div> }))
vi.mock('../finance/FinanceAIAnalysis', () => ({ FinanceAIAnalysis: () => <div>组合财务报告</div> }))
vi.mock('../settings/AISettingsPanel', () => ({ AISettingsPanel: () => <div>模型及提示词设置</div> }))
vi.mock('./AgentProposalReview', () => ({ AgentProposalReview: ({ projectId, proposalId }: { projectId: string; proposalId: string }) => <div>建议核对 {projectId} {proposalId}</div> }))
vi.mock('../task/ScheduleAssist', () => ({ ScheduleAssist: ({ editorDirty }: { editorDirty: boolean }) => <div>{editorDirty ? '排期预览已禁用' : '助手内智能排期'}</div> }))
vi.mock('../../data/bootstrap', () => ({ refreshAllData: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  useAuth.setState({ currentUser: users.find(user => user.role === 'admin')!, status: 'ready' })
  useDataStore.setState({ mode: 'api', ready: true, businessDate: '2026-11-14' })
  vi.mocked(pmAI.context).mockResolvedValue({ schemaVersion: 1, scope: { projectIds: [], taskIds: [] }, asOf: '2026-11-14', timezone: 'UTC', projects: [], tasks: [], members: [], subProjects: [], registerEntries: [], source: { schemaVersion: 1, asOf: '2026-11-14', complete: true, refs: [] } })
  vi.mocked(pmAI.list).mockResolvedValue({ items: [], total: 0 })
})

test('旧分析链接在同一助手打开综合评估，并保留报告核对标识，不自动生成', async () => {
  const key = 'a'.repeat(64)
  render(<MemoryRouter initialEntries={[`/projects/P1?tab=ai&agent_report=${key}`]}><PMAssistant projectId="P1" /></MemoryRouter>)
  expect(await screen.findByText(`评估范围 P1 ${key}`)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '综合评估' })).toHaveAttribute('aria-pressed', 'true')
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.context).not.toHaveBeenCalled()
})

test('Agent 提案在助手内核对，项目核对链接不进入任务抽屉', async () => {
  const view = render(<MemoryRouter initialEntries={['/projects/P1?assistant=proposal&agent_proposal=proposal-1']}><PMAssistant projectId="P1" /></MemoryRouter>)
  expect(await screen.findByText('建议核对 P1 proposal-1')).toBeInTheDocument()
  view.unmount()
  render(<MemoryRouter initialEntries={['/projects/P1?assistant=proposal&agent_proposal=proposal-1']}><PMAssistant projectId="P1" taskId="T1" standalone /></MemoryRouter>)
  expect(await screen.findByRole('button', { name: '项目 Agent' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByText('建议核对 P1 proposal-1')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '综合评估' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'AI 设置' })).not.toBeInTheDocument()
})

test('组合财务仅在全部项目范围可用，切换角色卸载管理内容', async () => {
  render(<MemoryRouter initialEntries={['/project-assistant?assistant=finance']}><PMAssistant standalone /></MemoryRouter>)
  expect(await screen.findByText('组合财务报告')).toBeInTheDocument()
  act(() => useAuth.setState({ currentUser: users.find(user => user.role === 'rd')! }))
  await waitFor(() => expect(screen.queryByText('组合财务报告')).not.toBeInTheDocument())
  expect(screen.queryByRole('button', { name: '组合财务' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'AI 设置' })).not.toBeInTheDocument()
})

test('选中项目后不会因财务链接读取整个组合，未保存任务也不挂载管理功能', async () => {
  const view = render(<MemoryRouter initialEntries={['/project-assistant?assistant=finance']}><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  expect(screen.getByText(/请将项目范围切换为全部可见项目/)).toBeInTheDocument()
  expect(screen.queryByText('组合财务报告')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '组合财务' })).not.toBeInTheDocument()
  view.unmount()
  render(<MemoryRouter initialEntries={['/projects/P1?assistant=assessment']}><PMAssistant projectId="P1" disabled standalone /></MemoryRouter>)
  expect(screen.getByRole('button', { name: '综合评估' })).toBeDisabled()
  expect(screen.queryByText('评估范围 P1')).not.toBeInTheDocument()
})

test('统一页面可选择当前可见项目，未知项目不回退为全部项目', async () => {
  render(<MemoryRouter initialEntries={['/project-assistant?project=missing&assistant=assessment']}><ProjectAssistant /></MemoryRouter>)
  expect(screen.getByRole('alert')).toHaveTextContent('项目不存在或不可访问')
  expect(pmAI.context).not.toHaveBeenCalled()
  const project = projects[0]
  fireEvent.change(screen.getByLabelText('助手项目范围'), { target: { value: project.id } })
  expect(await screen.findByText(`评估范围 ${project.id}`)).toBeInTheDocument()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('任务智能排期收进助手，未保存进展时保留内容并禁用操作，撤销管理角色后卸载', async () => {
  const task = tasks[0]
  const projectId = findSubProject(task.subProjectId)!.projectId
  const assistant = (disabled = false) => <MemoryRouter initialEntries={['/?assistant=schedule-assist']}>
    <PMAssistant projectId={projectId} taskId={task.id} taskSnapshot={task} disabled={disabled} standalone />
  </MemoryRouter>
  const view = render(assistant())
  expect(await screen.findByText('助手内智能排期')).toBeInTheDocument()
  view.rerender(assistant(true))
  expect(screen.getByText('排期预览已禁用')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '智能排期' })).toBeDisabled()
  act(() => useAuth.setState({ currentUser: users.find(user => user.role === 'rd')! }))
  expect(screen.queryByText('排期预览已禁用')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '智能排期' })).not.toBeInTheDocument()
})

function Location() { return <output aria-label="当前位置">{useLocation().pathname}{useLocation().search}</output> }

test('旧 AI 设置地址转到助手设置，直接进入不会自动生成分析', async () => {
  render(<MemoryRouter initialEntries={['/ai-settings']}><Routes>
    <Route path="/ai-settings" element={<AISettings />} />
    <Route path="/project-assistant" element={<><Location /><ProjectAssistant /></>} />
  </Routes></MemoryRouter>)
  expect(await screen.findByText('模型及提示词设置')).toBeInTheDocument()
  expect(screen.getByLabelText('当前位置')).toHaveTextContent('/project-assistant?assistant=settings')
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.context).not.toHaveBeenCalled()
})
