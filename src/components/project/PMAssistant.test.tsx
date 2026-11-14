import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { addDays, format } from 'date-fns'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { PMAssistant } from './PMAssistant'
import { PMAIActions } from './PMAIActions'
import { PMAIScheduleCompare } from './PMAIScheduleCompare'
import { pmAI, type PMAgentPlan, type PMAgentTarget, type PMAIContext, type PMAIRun } from '../../api/pmAI'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { subProjects, tasks, users, TODAY } from '../../mock'
import { refreshAllData } from '../../data/bootstrap'

vi.mock('../../api/pmAI', () => ({
  pmAI: {
    plan: vi.fn(),
    triage: vi.fn(),
    context: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    compare: vi.fn(),
    receipts: vi.fn(),
  },
}))
vi.mock('../../data/bootstrap', () => ({
  refreshAllData: vi.fn().mockResolvedValue(undefined),
}))

const source = {
  schemaVersion: 1,
  asOf: '2026-11-10',
  complete: true,
  refs: [
    {
      id: 'task:T1',
      type: 'task',
      entityId: 'T1',
      title: '试验任务',
      href: '/projects/P1?task=T1',
      observedAt: '2026-11-10',
      revision: 1,
    },
  ],
}
const context: PMAIContext = {
  schemaVersion: 1,
  scope: { projectIds: ['P1'], taskIds: ['T1'] },
  asOf: '2026-11-10',
  timezone: 'America/New_York',
  projects: [{ id: 'P1', code: 'P1', name: '测试项目', ownerId: 'owner' }],
  tasks: [
    {
      id: 'T1',
      code: 'T1',
      name: '试验任务',
      projectId: 'P1',
      subProjectId: 'S1',
      ownerId: 'owner',
      revision: 1,
    },
  ],
  members: [{ id: 'owner', name: '负责人' }],
  subProjects: [{ id: 'S1', name: '试验阶段', projectId: 'P1' }],
  registerEntries: [],
  source,
}
const run: PMAIRun = {
  id: 'R1',
  state: 'succeeded',
  scenario: 'explain',
  request: {
    scenario: 'explain',
    projectIds: ['P1'],
    taskIds: ['T1'],
    question: '为什么试验任务会阻塞？',
    material: '',
  },
  createdAt: '2026-11-10T10:00:00Z',
  source,
  error: '',
  result: {
    summary: '这项任务需要关注。',
    findings: [
      {
        title: '待处理事项',
        detail: '核对试验条件。',
        evidenceIds: ['task:T1'],
      },
    ],
    draftActions: [
      {
        kind: 'task_update',
        taskId: 'T1',
        expectedRevision: 1,
        progress: 30,
        reason: '会议确认进度',
        evidenceIds: ['task:T1'],
      },
    ],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(pmAI.plan).mockReset()
  vi.mocked(pmAI.triage).mockReset()
  vi.mocked(pmAI.create).mockReset()
  vi.mocked(pmAI.cancel).mockReset()
  sessionStorage.clear()
  useDataStore.setState({ mode: 'api', businessDate: '2026-11-10' })
  useAuth.setState({
    currentUser: users.find((user) => user.role === 'admin')!,
  })
  vi.mocked(pmAI.context).mockResolvedValue(context)
  vi.mocked(pmAI.list).mockResolvedValue({ items: [], total: 0 })
  vi.mocked(pmAI.get).mockReset().mockResolvedValue(run)
  vi.mocked(pmAI.receipts).mockResolvedValue([])
})

const projectTarget: PMAgentTarget = {
  kind: 'project', id: 'P007', projectId: 'P007', code: 'CMAB007Y',
  name: '007Y 预充针', projectName: '007Y 预充针',
}
const taskTarget: PMAgentTarget = {
  kind: 'task', id: 'T1', projectId: 'P1', code: 'T1',
  name: '试验任务', projectName: '测试项目',
}
function agentPlan(scenario: PMAgentPlan['scenario'], target = taskTarget): PMAgentPlan {
  return {
    status: 'ready', scenario, projectIds: [target.projectId],
    taskIds: target.kind === 'task' ? [target.id] : [], targets: [target], choices: [],
    message: '已确定当前范围', limit: 3, startDate: '2026-11-09', endDate: '2026-11-10',
  }
}
function sendQuestion(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '告诉我你想做什么' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
}
function openHistory() {
  if (!screen.queryByRole('button', { name: '刷新历史' })) fireEvent.click(screen.getByRole('button', { name: '历史' }))
}

test('首屏只保留单输入与自然提示，不自动打开历史失败或调用模型', async () => {
  const failed = { ...run, state: 'failed' as const, result: null, error: '旧模型输出被截断' }
  vi.mocked(pmAI.list).mockResolvedValue({ items: [failed], total: 1 })
  render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  expect(screen.getByRole('textbox', { name: '告诉我你想做什么' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '查看待关注任务' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '整理本周周报' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '粘贴会议记录' })).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'AI 使用场景' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '识别范围与操作' })).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: '分析记录' })).not.toBeInTheDocument()
  expect(screen.queryByText('旧模型输出被截断')).not.toBeInTheDocument()
  expect(pmAI.get).not.toHaveBeenCalled()
  expect(pmAI.plan).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
  openHistory()
  expect(await screen.findByRole('button', { name: /为什么试验任务会阻塞/ })).toBeInTheDocument()
  expect(pmAI.get).not.toHaveBeenCalled()
})

test('明确的问题一次发送即按当前任务生成分析并显示依据，不执行建议', async () => {
  const question = '试验任务本周为什么阻塞？'
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('explain'))
  vi.mocked(pmAI.create).mockResolvedValue(run)
  render(<MemoryRouter><PMAssistant projectId="P1" taskId="T1" standalone /></MemoryRouter>)
  sendQuestion(question)
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(pmAI.plan).toHaveBeenCalledOnce()
  expect(pmAI.plan).toHaveBeenCalledWith(question, 'P1', 'T1')
  expect(pmAI.create).toHaveBeenCalledOnce()
  expect(pmAI.create).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'explain', projectIds: ['P1'], taskIds: ['T1'], question }))
  expect(screen.getAllByRole('link', { name: '试验任务' })[0]).toHaveAttribute('href', '/projects/P1?task=T1')
  expect(screen.queryByRole('button', { name: '按此范围分析' })).not.toBeInTheDocument()
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('旧异常解释深链带入能识别的默认问题，发送一次直接整理而非任务清单', async () => {
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('explain'))
  vi.mocked(pmAI.create).mockResolvedValue(run)
  render(<MemoryRouter initialEntries={['/?assistant=explain']}><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  const question = '当前项目哪些任务可能延期，为什么？'
  expect(screen.getByRole('textbox', { name: '告诉我你想做什么' })).toHaveValue(question)
  expect(pmAI.plan).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(pmAI.plan).toHaveBeenCalledExactlyOnceWith(question, 'P1', undefined)
  expect(pmAI.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scenario: 'explain', question }))
  expect(pmAI.triage).not.toHaveBeenCalled()
})

test.each([
  ['priorities', '当前有哪些需要优先处理的任务？'],
  ['weekly', '整理本周项目周报'],
  ['meeting', '请整理会议记录并提取待核对的更新'],
  ['followup', '已有措施落实了吗，还有哪些阻塞？'],
])('旧%s深链保留可编辑的预填要求，打开不会自动请求', (scenario, question) => {
  render(<MemoryRouter initialEntries={[`/?assistant=${scenario}`]}><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  expect(screen.getByRole('textbox', { name: '告诉我你想做什么' })).toHaveValue(question)
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  expect(pmAI.plan).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.triage).not.toHaveBeenCalled()
})

test.each([
  [undefined, '比较项目任务的排期方案'],
  ['T1', '比较当前任务分别顺延 2 或 5 个工作日的排期方案'],
])('旧排期链接保留输入入口，打开只预填而不推演（任务：%s）', (taskId, question) => {
  render(<MemoryRouter initialEntries={['/?assistant=schedule']}><PMAssistant projectId="P1" taskId={taskId} standalone /></MemoryRouter>)
  expect(screen.getByRole('textbox', { name: '告诉我你想做什么' })).toHaveValue(question)
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  expect(pmAI.plan).not.toHaveBeenCalled()
  expect(pmAI.compare).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('外部分析深链接自动打开准确结果，保留本人历史范围过滤', async () => {
  vi.mocked(pmAI.get).mockResolvedValue({ ...run, scope: { projectIds: ['P1'], taskIds: ['T1'] }, request: { ...run.request, projectIds: [] } })
  render(<MemoryRouter initialEntries={['/projects/P1?aiRun=R1']}><PMAssistant projectId="P1" /></MemoryRouter>)
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(pmAI.get).toHaveBeenCalledWith('R1')
  expect(pmAI.list).toHaveBeenCalledWith('P1', undefined)
  expect(screen.getByText('项目 AI 助手').closest('details')).toHaveAttribute('open')
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('范围不匹配的深链接不回退显示另一份历史结果', async () => {
  vi.mocked(pmAI.list).mockResolvedValue({ items: [run], total: 1 })
  vi.mocked(pmAI.get).mockResolvedValue({ ...run, request: { ...run.request, projectIds: ['another-project'] } })
  render(<MemoryRouter initialEntries={['/projects/P1?aiRun=unrelated']}><PMAssistant projectId="P1" /></MemoryRouter>)
  expect(await screen.findByRole('alert')).toHaveTextContent('不属于当前项目或任务')
  expect(screen.queryByText('这项任务需要关注。')).not.toBeInTheDocument()
})

test('当前上下文超限时仍可查看已保存结果，但不能伪称其仍然有效', async () => {
  vi.mocked(pmAI.context).mockRejectedValue(new Error('当前项目资料超过范围上限'))
  vi.mocked(pmAI.get).mockResolvedValue({ ...run, stale: true, staleReason: 'context_budget' })
  render(<MemoryRouter initialEntries={['/projects/P1?aiRun=R1']}><PMAssistant projectId="P1" /></MemoryRouter>)
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(screen.getByText(/暂时无法判断结果是否仍然有效/)).toBeInTheDocument()
  openHistory()
  expect(screen.getByText(/当前项目资料超过范围上限/)).toBeInTheDocument()
})

test('新问题不取消已提交后台任务，停止动作才明确请求取消', async () => {
  const queued = { ...run, state: 'queued' as const, result: null }
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('explain'))
  vi.mocked(pmAI.create).mockResolvedValue(queued)
  vi.mocked(pmAI.cancel).mockResolvedValue({ ...queued, state: 'cancelled' })
  render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  sendQuestion('为什么延期？')
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledOnce())
  fireEvent.click(await screen.findByRole('button', { name: /^停止/ }))
  await waitFor(() => expect(pmAI.cancel).toHaveBeenCalledWith('R1'))
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  expect(pmAI.cancel).toHaveBeenCalledOnce()
  expect(screen.queryByText('这项任务需要关注。')).not.toBeInTheDocument()
  sendQuestion('再分析一次')
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  expect(pmAI.cancel).toHaveBeenCalledOnce()
})

test('未保存任务进展禁止发送和快捷发起，不调用规划或生成接口', async () => {
  render(<MemoryRouter><PMAssistant projectId="P1" taskId="T1" disabled standalone /></MemoryRouter>)
  fireEvent.change(screen.getByRole('textbox', { name: '告诉我你想做什么' }), { target: { value: '整理本周周报' } })
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '整理本周周报' })).toBeDisabled()
  expect(pmAI.plan).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('重点请求一次发送直接列出本人任务和理由，不生成模型报告', async () => {
  const question = '007Y 项目我最需要处理的 3 项工作'
  vi.mocked(pmAI.plan).mockResolvedValue({ ...agentPlan('priorities', projectTarget), mineOnly: true })
  vi.mocked(pmAI.triage).mockResolvedValue({
    businessDate: '2026-11-10', limit: 3, totalCandidates: 5,
    items: ['受阻事项', '逾期事项', '关键里程碑'].map((name, index) => ({
      taskId: `priority-${index}`, projectId: 'P007', projectName: '007Y 预充针', code: `PR-${index}`, name,
      status: '进行中', plannedEnd: '2026-11-10', ownerName: '负责人', reasons: [['已阻塞'], ['逾期 2 天'], ['里程碑']][index],
      href: `/projects/P007?tab=wbs&task=priority-${index}`,
    })),
  })
  render(<MemoryRouter><PMAssistant standalone /></MemoryRouter>)
  sendQuestion(question)
  expect(await screen.findByRole('link', { name: /受阻事项$/ })).toHaveAttribute('href', '/projects/P007?tab=wbs&task=priority-0')
  expect(screen.getByRole('link', { name: /逾期事项$/ })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /关键里程碑$/ })).toBeInTheDocument()
  expect(pmAI.plan).toHaveBeenCalledWith(question, undefined, undefined)
  expect(pmAI.triage).toHaveBeenCalledWith({ projectIds: ['P007'], taskIds: [] }, 3, true, 'attention')
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('延期请求把识别出的筛选直接交给事实查询，不扩展为全部重点', async () => {
  vi.mocked(pmAI.plan).mockResolvedValue({ ...agentPlan('priorities'), ...{ taskFilter: 'delayed' as const } })
  vi.mocked(pmAI.triage).mockResolvedValue({ businessDate: '2026-11-10', limit: 3, totalCandidates: 0, items: [] })
  render(<MemoryRouter><PMAssistant projectId="P1" taskId="T1" standalone /></MemoryRouter>)
  sendQuestion('这项任务是否延期？')
  await waitFor(() => expect(pmAI.triage).toHaveBeenCalledWith({ projectIds: ['P1'], taskIds: ['T1'] }, 3, false, 'delayed'))
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('同名任务只追问对象，选择后自动继续且只分析选中任务', async () => {
  const question = '试验任务本周为何阻塞'
  const otherTask = { ...taskTarget, id: 'T2', projectId: 'P2', code: 'T2', projectName: '另一项目' }
  vi.mocked(pmAI.plan).mockResolvedValueOnce({ ...agentPlan('explain'), status: 'clarify', projectIds: [], targets: [], choices: [taskTarget, otherTask], message: '检测到多个匹配任务，请选择一个任务' }).mockResolvedValueOnce(agentPlan('explain'))
  vi.mocked(pmAI.create).mockResolvedValue(run)
  render(<MemoryRouter><PMAssistant standalone /></MemoryRouter>)
  sendQuestion(question)
  expect(await screen.findByText('检测到多个匹配任务，请选择一个任务')).toBeInTheDocument()
  expect(pmAI.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /试验任务.*T1.*测试项目/ }))
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(pmAI.plan).toHaveBeenLastCalledWith(question, 'P1', 'T1')
  expect(pmAI.create).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'explain', projectIds: ['P1'], taskIds: ['T1'], startDate: '2026-11-09', endDate: '2026-11-10', question }))
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('完整会议原文一次发送后直接作为材料，不重复输入或截断', async () => {
  const material = '会议记录：\n' + '试验任务已推进至30%，请核对本次原文。'.repeat(260)
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('meeting'))
  vi.mocked(pmAI.create).mockResolvedValue({ ...run, scenario: 'meeting' })
  render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  sendQuestion(material)
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledOnce())
  const payload = vi.mocked(pmAI.create).mock.calls[0][0]
  expect(payload.material).toContain(material)
  expect(payload.material.length).toBeGreaterThan(5000)
  expect(payload.question.length).toBeLessThanOrEqual(2000)
  expect(payload.scenario).toBe('meeting')
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('普通长问题不能截断成另一句请求提交', async () => {
  const question = '请核对项目的延期原因。'.repeat(240)
  vi.mocked(pmAI.plan).mockRejectedValue(new Error('问题过长，请缩短提问'))
  render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  sendQuestion(question)
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  if (vi.mocked(pmAI.plan).mock.calls.length) expect(vi.mocked(pmAI.plan).mock.calls[0][0]).toBe(question)
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('清除本地等待后，迟到的规划不生成或覆盖新问题', async () => {
  let resolvePlan: (value: PMAgentPlan) => void = () => {}
  vi.mocked(pmAI.plan).mockImplementationOnce(() => new Promise(resolve => { resolvePlan = resolve })).mockResolvedValueOnce(agentPlan('weekly'))
  vi.mocked(pmAI.create).mockResolvedValue({ ...run, scenario: 'weekly', result: { ...run.result!, summary: '新问题的周报' } })
  render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  sendQuestion('旧问题为什么延期')
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  sendQuestion('整理本周周报')
  expect(await screen.findByText('新问题的周报')).toBeInTheDocument()
  await act(async () => resolvePlan(agentPlan('explain')))
  expect(pmAI.create).toHaveBeenCalledOnce()
  expect(screen.getByText('新问题的周报')).toBeInTheDocument()
})

test('已发起分析的迟到回执可保留后台记录，但不覆盖新问题结果', async () => {
  let finishCreate: (value: PMAIRun) => void = () => {}
  vi.mocked(pmAI.plan).mockResolvedValueOnce(agentPlan('explain')).mockResolvedValueOnce(agentPlan('weekly'))
  vi.mocked(pmAI.create).mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve })).mockResolvedValueOnce({ ...run, id: 'R2', scenario: 'weekly', result: { ...run.result!, summary: '最新周报结果' } })
  render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  sendQuestion('先分析延期原因')
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  sendQuestion('整理本周周报')
  expect(await screen.findByText('最新周报结果')).toBeInTheDocument()
  await act(async () => finishCreate(run))
  expect(screen.queryByText('这项任务需要关注。')).not.toBeInTheDocument()
  expect(screen.getByText('最新周报结果')).toBeInTheDocument()
  expect(pmAI.cancel).not.toHaveBeenCalled()
})

test('切换项目后丢弃旧范围迟到规划，避免在新页面继续生成旧项目报告', async () => {
  let finishPlan: (value: PMAgentPlan) => void = () => {}
  vi.mocked(pmAI.plan).mockImplementationOnce(() => new Promise(resolve => { finishPlan = resolve }))
  const view = render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  sendQuestion('分析当前项目延期原因')
  view.rerender(<MemoryRouter><PMAssistant projectId="P2" standalone /></MemoryRouter>)
  await act(async () => finishPlan(agentPlan('explain')))
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(screen.queryByText('这项任务需要关注。')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
})

test('明确排期方案一次发送自动读取预览，不自动确认日期修改', async () => {
  vi.mocked(pmAI.plan).mockResolvedValue({ ...agentPlan('schedule'), delays: [2, 8] })
  vi.mocked(pmAI.compare).mockResolvedValue({ plans: [] })
  render(<MemoryRouter><PMAssistant projectId="P1" taskId="T1" standalone /></MemoryRouter>)
  sendQuestion('试验任务比较顺延2或8个工作日')
  await waitFor(() => expect(pmAI.compare).toHaveBeenCalledWith('P1', 'T1', [2, 8], []))
  expect(screen.getByRole('textbox', { name: '顺延工作日方案' })).toHaveValue('2,8')
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('周报草稿可本地编辑和清空，原分析、依据与建议不被写回', async () => {
  const weekly = { ...run, scenario: 'weekly' as const, result: { ...run.result!, summary: '原始周报内容', draftActions: [] } }
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('weekly'))
  vi.mocked(pmAI.create).mockResolvedValue(weekly)
  render(<MemoryRouter><PMAssistant projectId="P1" taskId="T1" standalone /></MemoryRouter>)
  sendQuestion('整理本周周报')
  fireEvent.click(await screen.findByRole('button', { name: '编辑草稿' }))
  const editor = screen.getByRole('textbox', { name: '编辑周报草稿' })
  fireEvent.change(editor, { target: { value: '本地修改后的周报' } })
  fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
  expect(screen.getByText('本地修改后的周报')).toBeInTheDocument()
  expect(weekly.result.summary).toBe('原始周报内容')
  expect(weekly.source.refs[0].title).toBe('试验任务')
  expect(pmAI.create).toHaveBeenCalledOnce()
  expect(pmAI.apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '编辑草稿' }))
  fireEvent.change(screen.getByRole('textbox', { name: '编辑周报草稿' }), { target: { value: '' } })
  expect(screen.getByRole('textbox', { name: '编辑周报草稿' })).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
  expect(screen.getByText('草稿内容为空，可继续编辑。')).toBeInTheDocument()
  expect(screen.queryByText('原始周报内容')).not.toBeInTheDocument()
})

test('历史记录慢响应不覆盖最新选择，更新状态只读取当前记录', async () => {
  const second: PMAIRun = { ...run, id: 'R2', state: 'running', request: { ...run.request, question: '第二个历史问题' }, result: null }
  let finishFirst: (value: PMAIRun) => void = () => {}
  vi.mocked(pmAI.list).mockResolvedValue({ items: [run, second], total: 2 })
  vi.mocked(pmAI.get).mockImplementation(id => id === 'R1' ? new Promise(resolve => { finishFirst = resolve }) : Promise.resolve(second))
  render(<MemoryRouter><PMAssistant projectId="P1" taskId="T1" standalone /></MemoryRouter>)
  openHistory()
  fireEvent.click(await screen.findByRole('button', { name: /为什么试验任务会阻塞/ }))
  await waitFor(() => expect(pmAI.get).toHaveBeenCalledWith('R1'))
  openHistory()
  fireEvent.click(await screen.findByRole('button', { name: /第二个历史问题/ }))
  expect(await screen.findByRole('button', { name: '停止整理' })).toBeInTheDocument()
  expect(screen.getByText('第二个历史问题')).toBeInTheDocument()
  await act(async () => finishFirst(run))
  expect(screen.queryByText('这项任务需要关注。')).not.toBeInTheDocument()
  vi.mocked(pmAI.get).mockResolvedValue({ ...second, state: 'succeeded', result: { ...run.result!, summary: '第二份分析已刷新' } })
  fireEvent.click(screen.getByRole('button', { name: '更新状态' }))
  expect(await screen.findByText('第二份分析已刷新')).toBeInTheDocument()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('规划等待时选择历史会解锁输入，旧规划迟到不覆盖后续请求', async () => {
  let finishOld: (value: PMAgentPlan) => void = () => {}
  vi.mocked(pmAI.plan).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockResolvedValueOnce(agentPlan('weekly'))
  vi.mocked(pmAI.list).mockResolvedValue({ items: [run], total: 1 })
  vi.mocked(pmAI.create).mockResolvedValue({ ...run, id: 'R2', scenario: 'weekly', result: { ...run.result!, summary: '历史之后的新周报' } })
  render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  sendQuestion('先解释当前项目延期')
  openHistory()
  fireEvent.click(await screen.findByRole('button', { name: /为什么试验任务会阻塞/ }))
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: '告诉我你想做什么' }), { target: { value: '整理本周周报' } })
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText('历史之后的新周报')).toBeInTheDocument()
  await act(async () => finishOld(agentPlan('explain')))
  expect(pmAI.create).toHaveBeenCalledOnce()
  expect(screen.getByText('历史之后的新周报')).toBeInTheDocument()
})

test('失败会议可带回完整原文且不自动重试，新问题不残留失败状态', async () => {
  const previous: PMAIRun = { ...run, scenario: 'meeting', state: 'failed', result: null, error: '模型调用超时', request: { ...run.request, scenario: 'meeting', question: '整理行动项', material: '试验任务推进至 30%', startDate: '2026-11-01', endDate: '2026-11-10' } }
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  render(<MemoryRouter initialEntries={['/projects?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  expect((screen.getByRole('textbox', { name: '告诉我你想做什么' }) as HTMLTextAreaElement).value).toContain('试验任务推进至 30%')
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByText('模型调用超时')).not.toBeInTheDocument()
})

test('从失败记录开始新问题，不带入旧错误或自动执行旧条件', async () => {
  vi.mocked(pmAI.get).mockResolvedValue({ ...run, state: 'failed', result: null, error: '上次输出被截断' })
  render(<MemoryRouter initialEntries={['/projects?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  await screen.findByRole('button', { name: '调整要求' })
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  expect(screen.queryByText('上次输出被截断')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '告诉我你想做什么' })).toHaveValue('')
  expect(pmAI.create).not.toHaveBeenCalled()
})

function legacyMeeting(scope = { projectIds: ['P1'], taskIds: ['T1'] }): PMAIRun {
  return {
    ...run, scenario: 'meeting', scope, state: 'failed', result: null, error: '旧记录未完成',
    request: { scenario: 'meeting', projectIds: [], taskIds: [], question: '按旧会议要求整理行动项',
      material: '试验任务现已推进至30%，请核对试验条件并记录后续责任。'.repeat(250),
      startDate: '2026-10-01', endDate: '2026-10-08' },
  }
}

test('旧会议无前缀长原文沿用后保留真实范围和日期，不重新识别或截断', async () => {
  const previous = legacyMeeting()
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  vi.mocked(pmAI.create).mockResolvedValue({ ...previous, id: 'new-meeting', state: 'queued', error: '' })
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  const editor = screen.getByRole('textbox', { name: '告诉我你想做什么' })
  expect(editor).toHaveValue(previous.request.material)
  const material = previous.request.material + '\n请同时保留本次讨论的限制条件。'
  fireEvent.change(editor, { target: { value: material } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledExactlyOnceWith({ ...previous.request, ...previous.scope!, material }))
  expect(material.length).toBeGreaterThan(5000)
  expect(pmAI.plan).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('历史周报调整问题时保留原场景、真实任务范围和原日期', async () => {
  const previous: PMAIRun = { ...run, scenario: 'weekly', scope: { projectIds: ['P1'], taskIds: ['T1'] }, request: { ...run.request, scenario: 'weekly', projectIds: [], taskIds: [], question: '总结原来的周报', startDate: '2026-09-14', endDate: '2026-09-20' } }
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  vi.mocked(pmAI.create).mockResolvedValue({ ...previous, id: 'updated-weekly' })
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  sendQuestion('只保留风险和待决定事项')
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledExactlyOnceWith({ ...previous.request, ...previous.scope!, question: '只保留风险和待决定事项' }))
  expect(pmAI.plan).not.toHaveBeenCalled()
})

test('调整旧请求后选择新问题清除旧场景、日期和材料', async () => {
  const previous = legacyMeeting()
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('weekly'))
  vi.mocked(pmAI.create).mockResolvedValue({ ...run, scenario: 'weekly' })
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  sendQuestion('整理本周项目周报')
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledOnce())
  expect(pmAI.plan).toHaveBeenCalledWith('整理本周项目周报', undefined, undefined)
  expect(pmAI.create).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'weekly', material: '', startDate: '2026-11-09', endDate: '2026-11-10' }))
})

test('调整旧请求后选择另一份历史清除待沿用条件', async () => {
  const previous = legacyMeeting()
  const other = { ...run, id: 'other-history', request: { ...run.request, question: '另一个历史问题' } }
  vi.mocked(pmAI.list).mockResolvedValue({ items: [previous, other], total: 2 })
  vi.mocked(pmAI.get).mockImplementation(id => Promise.resolve(id === 'R1' ? previous : other))
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('priorities'))
  vi.mocked(pmAI.triage).mockResolvedValue({ businessDate: '2026-11-10', limit: 3, totalCandidates: 0, items: [] })
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  openHistory()
  fireEvent.click(await screen.findByRole('button', { name: /另一个历史问题/ }))
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  sendQuestion('当前任务有哪些工作重点？')
  await waitFor(() => expect(pmAI.triage).toHaveBeenCalled())
  expect(pmAI.plan).toHaveBeenCalledWith('当前任务有哪些工作重点？', undefined, undefined)
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('调整旧请求后切换项目清除沿用范围，下一次发送按新项目识别', async () => {
  const previous = legacyMeeting()
  vi.mocked(pmAI.list).mockResolvedValue({ items: [previous], total: 1 })
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  const view = render(<MemoryRouter><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  openHistory()
  fireEvent.click(await screen.findByRole('button', { name: /按旧会议要求整理行动项/ }))
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  const target = { ...taskTarget, id: 'T2', projectId: 'P2', code: 'T2', projectName: '第二项目' }
  vi.mocked(pmAI.plan).mockResolvedValue(agentPlan('explain', target))
  vi.mocked(pmAI.create).mockResolvedValue({ ...run, request: { ...run.request, projectIds: ['P2'], taskIds: ['T2'] } })
  view.rerender(<MemoryRouter><PMAssistant projectId="P2" standalone /></MemoryRouter>)
  sendQuestion('解释当前项目延期原因')
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledOnce())
  expect(pmAI.plan).toHaveBeenCalledWith('解释当前项目延期原因', 'P2', undefined)
  expect(pmAI.create).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'explain', projectIds: ['P2'], taskIds: ['T2'], material: '' }))
})

test.each(['调整要求', '重新整理简版'])('固定项目页不能重发组合范围或静默缩小历史条件（%s）', async (buttonName) => {
  const previous = legacyMeeting({ projectIds: ['P1', 'P2'], taskIds: [] })
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant projectId="P1" standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: buttonName }))
  expect(await screen.findByText(/请从原范围打开/)).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '告诉我你想做什么' })).toHaveValue('')
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.plan).not.toHaveBeenCalled()
})

test('全项目页面可显式沿用历史组合范围，不按当前上下文裁剪项目', async () => {
  const previous = legacyMeeting({ projectIds: ['P1', 'P2'], taskIds: [] })
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  vi.mocked(pmAI.create).mockResolvedValue({ ...previous, id: 'new-portfolio-meeting', state: 'queued', error: '' })
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledExactlyOnceWith({ ...previous.request, ...previous.scope! }))
  expect(pmAI.plan).not.toHaveBeenCalled()
})

test('历史失败的简版重试也绑定真实scope，而非旧请求的空范围', async () => {
  const previous = legacyMeeting()
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  vi.mocked(pmAI.create).mockResolvedValue({ ...previous, id: 'retry-meeting', state: 'queued', error: '' })
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '重新整理简版' }))
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledOnce())
  expect(pmAI.create).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'meeting', ...previous.scope!, material: previous.request.material, startDate: previous.request.startDate, endDate: previous.request.endDate }))
  expect(pmAI.plan).not.toHaveBeenCalled()
})

test('调整历史日期只改变日期条件，保留原场景、真实范围和完整会议材料', async () => {
  const previous = legacyMeeting()
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  vi.mocked(pmAI.create).mockResolvedValue({ ...previous, id: 'dated-meeting', state: 'queued', error: '' })
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  fireEvent.click(screen.getByText('调整日期', { selector: 'summary' }))
  fireEvent.change(screen.getByLabelText('调整开始日期'), { target: { value: '2026-10-12' } })
  fireEvent.change(screen.getByLabelText('调整结束日期'), { target: { value: '2026-10-18' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledExactlyOnceWith({ ...previous.request, ...previous.scope!, startDate: '2026-10-12', endDate: '2026-10-18' }))
  expect(pmAI.plan).not.toHaveBeenCalled()
})

test.each([
  ['', '2026-10-18', /补齐开始和结束日期/],
  ['2026-10-19', '2026-10-18', /开始日期不能晚于结束日期/],
])('调整日期不完整或倒置时保留材料且不生成（%s → %s）', async (startDate, endDate, error) => {
  const previous = legacyMeeting()
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  render(<MemoryRouter initialEntries={['/?aiRun=R1']}><PMAssistant standalone /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '调整要求' }))
  fireEvent.click(screen.getByText('调整日期', { selector: 'summary' }))
  fireEvent.change(screen.getByLabelText('调整开始日期'), { target: { value: startDate } })
  fireEvent.change(screen.getByLabelText('调整结束日期'), { target: { value: endDate } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText(error)).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '告诉我你想做什么' })).toHaveValue(previous.request.material)
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.plan).not.toHaveBeenCalled()
})

test('预览后仍需明确确认，网络重试恢复同一确认并保留写入回执', async () => {
  const preview = {
    actions: run.result!.draftActions,
    changes: [
      {
        kind: 'task_update',
        entityId: 'T1',
        title: '试验任务',
        before: { id: 'T1', code: 'T1', progress: 0 },
        after: { id: 'T1', code: 'T1', progress: 30 },
        evidenceIds: ['task:T1'],
      },
    ],
    confirmationToken: 'same-token',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  vi.mocked(pmAI.preview).mockResolvedValue(preview)
  vi.mocked(pmAI.apply)
    .mockRejectedValueOnce(new Error('network timeout'))
    .mockResolvedValueOnce({
      receiptId: 'receipt-1',
      replayed: true,
      results: [
        {
          kind: 'task_update',
          entityId: 'T1',
          title: '试验任务',
          href: '/projects/P1?task=T1',
        },
      ],
      verified: true,
    })
  const view = render(
    <MemoryRouter>
      <PMAIActions
        run={run}
        context={context}
        userId="owner"
        disabled={false}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: '预览操作差异' }))
  expect(
    await screen.findByRole('button', { name: '确认应用 1 项操作' }),
  ).toBeEnabled()
  expect(screen.queryByText('id', { selector: 'dt' })).not.toBeInTheDocument()
  expect(screen.queryByText('code', { selector: 'dt' })).not.toBeInTheDocument()
  expect(pmAI.apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认应用 1 项操作' }))
  await screen.findByRole('button', { name: '重试本次确认' })
  view.unmount()
  render(
    <MemoryRouter>
      <PMAIActions
        run={run}
        context={context}
        userId="owner"
        disabled={false}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: '重试本次确认' }))
  expect(
    await screen.findByText('操作已完成并核验 · 回执 receipt-1'),
  ).toBeInTheDocument()
  expect(vi.mocked(pmAI.apply).mock.calls).toEqual([
    ['R1', 'same-token'],
    ['R1', 'same-token'],
  ])
  expect(refreshAllData).toHaveBeenCalledTimes(1)
})

test('排期方案的人力影响随页面数据刷新重新计算', async () => {
  const originals = {
    tasks: [...tasks],
    subProjects: [...subProjects],
    users: [...users],
  }
  const start = format(TODAY, 'yyyy-MM-dd')
  const end = format(addDays(TODAY, 4), 'yyyy-MM-dd')
  tasks.splice(0, tasks.length, {
    id: 'T1',
    code: 'T1',
    name: '试验任务',
    subProjectId: 'S1',
    ownerId: 'owner',
    status: '未开始',
    priority: '中',
    plannedStart: start,
    plannedEnd: end,
    estimatedEffort: 5,
    progress: 0,
    isMilestone: false,
    isCriticalPath: false,
  })
  subProjects.splice(0, subProjects.length, {
    id: 'S1',
    projectId: 'P1',
    name: '试验阶段',
    stage: '临床前',
    module: 'USP',
    status: '未开始',
    progress: 0,
    sortOrder: 0,
  })
  const owner = { ...users[0], id: 'owner', weeklyAvailableHours: 40 }
  users.push(owner)
  vi.mocked(pmAI.compare).mockResolvedValue({
    plans: [
      {
        delayWorkdays: 1,
        lockedMilestones: [],
        schedule: {
          fingerprint: 'snapshot',
          changes: [],
          conflicts: [],
          previousFinish: end,
          newFinish: end,
        },
        confirmationToken: 'schedule-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  })
  try {
    render(
      <MemoryRouter>
        <PMAIScheduleCompare
          projectId="P1"
          taskId="T1"
          userId="owner"
          context={context}
          disabled={false}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: '比较排期方案' }))
    expect(await screen.findByText(/基于当前页面数据估算/)).toHaveTextContent(
      '超负荷人周 0 → 0',
    )
    act(() => {
      owner.weeklyAvailableHours = 0
      useDataStore.getState().bump()
    })
    expect(screen.getByText(/基于当前页面数据估算/)).not.toHaveTextContent(
      '超负荷人周 0 → 0',
    )
  } finally {
    tasks.splice(0, tasks.length, ...originals.tasks)
    subProjects.splice(0, subProjects.length, ...originals.subProjects)
    users.splice(0, users.length, ...originals.users)
  }
})
