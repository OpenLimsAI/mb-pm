import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    question: '',
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

test('带入选中任务并显示可打开的依据，生成分析不会执行建议', async () => {
  vi.mocked(pmAI.create).mockResolvedValue(run)
  render(
    <MemoryRouter>
      <PMAssistant projectId="P1" taskId="T1" />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByText('项目 AI 助手'))
  fireEvent.click(await screen.findByRole('button', { name: '异常解释' }))
  const generate = await screen.findByRole('button', { name: '生成分析' })
  await waitFor(() => expect(generate).toBeEnabled())
  fireEvent.click(generate)
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(pmAI.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scenario: 'explain',
      projectIds: ['P1'],
      taskIds: ['T1'],
    }),
  )
  expect(screen.getAllByRole('link', { name: '试验任务' })[0]).toHaveAttribute(
    'href',
    '/projects/P1?task=T1',
  )
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('外部工具返回的分析深链接自动打开对应结果', async () => {
  vi.mocked(pmAI.get).mockResolvedValue({
    ...run,
    scope: { projectIds: ['P1'], taskIds: ['T1'] },
    request: { ...run.request, projectIds: [] },
  })
  render(
    <MemoryRouter initialEntries={['/projects/P1?aiRun=R1']}>
      <PMAssistant projectId="P1" />
    </MemoryRouter>,
  )
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(pmAI.get).toHaveBeenCalledWith('R1')
  expect(pmAI.list).toHaveBeenCalledWith('P1', undefined)
  expect(screen.getByRole('button', { name: '异常解释' })).toHaveClass('bg-brand-600')
  expect(screen.getByText('项目 AI 助手').closest('details')).toHaveAttribute(
    'open',
  )
})

test('范围不匹配的深链接不回退显示另一份历史结果', async () => {
  vi.mocked(pmAI.list).mockResolvedValue({ items: [run], total: 1 })
  vi.mocked(pmAI.get).mockResolvedValue({
    ...run,
    request: { ...run.request, projectIds: ['another-project'] },
  })
  render(
    <MemoryRouter initialEntries={['/projects/P1?aiRun=unrelated']}>
      <PMAssistant projectId="P1" />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '不属于当前项目或任务',
  )
  expect(screen.queryByText('这项任务需要关注。')).not.toBeInTheDocument()
})

test('当前上下文超过上限时，仍可按深链接查看已保存结果', async () => {
  vi.mocked(pmAI.context).mockRejectedValue(new Error('当前项目资料超过范围上限'))
  vi.mocked(pmAI.get).mockResolvedValue({ ...run, stale: true, staleReason: 'context_budget' })
  render(
    <MemoryRouter initialEntries={['/projects/P1?aiRun=R1']}>
      <PMAssistant projectId="P1" />
    </MemoryRouter>,
  )
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(screen.getByText(/暂时无法判断结果是否仍然有效/)).toBeInTheDocument()
  expect(screen.getByText(/当前项目资料超过范围上限/)).toBeInTheDocument()
})

test('后台分析可取消，未保存的任务进展阻止新分析', async () => {
  const queued = { ...run, state: 'queued' as const, result: null }
  vi.mocked(pmAI.create).mockResolvedValue(queued)
  vi.mocked(pmAI.cancel).mockResolvedValue({ ...queued, state: 'cancelled' })
  const view = render(
    <MemoryRouter>
      <PMAssistant projectId="P1" />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByText('项目 AI 助手'))
  fireEvent.click(await screen.findByRole('button', { name: '异常解释' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '生成分析' })).toBeEnabled(),
  )
  fireEvent.click(screen.getByRole('button', { name: '生成分析' }))
  fireEvent.click(await screen.findByRole('button', { name: '取消本次分析' }))
  await waitFor(() => expect(pmAI.cancel).toHaveBeenCalledWith('R1'))
  expect(await screen.findByText('已取消')).toBeInTheDocument()
  view.rerender(
    <MemoryRouter>
      <PMAssistant projectId="P1" disabled />
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: '生成分析' })).toBeDisabled()
})

const projectTarget: PMAgentTarget = {
  kind: 'project', id: 'P007', projectId: 'P007', code: 'CMAB007Y',
  name: '007Y 预充针', projectName: '007Y 预充针',
}
const taskTarget: PMAgentTarget = {
  kind: 'task', id: 'T1', projectId: 'P1', code: 'T1',
  name: '试验任务', projectName: '测试项目',
}

function agentPlan(scenario: PMAgentPlan['scenario'], target = projectTarget): PMAgentPlan {
  return {
    status: 'ready', scenario, projectIds: [target.projectId],
    taskIds: target.kind === 'task' ? [target.id] : [], targets: [target], choices: [],
    message: '已确定操作，请核对后继续', limit: 3,
  }
}

async function askAgent(question: string) {
  fireEvent.click(screen.getByText('项目 AI 助手'))
  fireEvent.change(await screen.findByRole('textbox', { name: '向项目 Agent 提问' }), {
    target: { value: question },
  })
  fireEvent.click(screen.getByRole('button', { name: '识别范围与操作' }))
}

test('Agent 核对 007Y 和个人范围后，显示限量排序及可打开的任务', async () => {
  const question = '007Y 项目我最需要处理的 3 项工作'
  vi.mocked(pmAI.plan).mockResolvedValue({ ...agentPlan('priorities'), mineOnly: true })
  vi.mocked(pmAI.triage).mockResolvedValue({
    businessDate: '2026-11-10', limit: 3, totalCandidates: 5,
    items: ['受阻事项', '逾期事项', '关键里程碑'].map((name, index) => ({
      taskId: `priority-${index}`, projectId: 'P007', projectName: '007Y 预充针',
      code: `PR-${index}`, name, status: '进行中', plannedEnd: '2026-11-10',
      ownerName: '负责人', reasons: [['已阻塞'], ['逾期 2 天'], ['里程碑']][index],
      href: `/projects/P007?tab=wbs&task=priority-${index}`,
    })),
  })
  render(<MemoryRouter><PMAssistant /></MemoryRouter>)
  await askAgent(question)
  expect(await screen.findByText('实际范围 007Y 预充针 · 我的任务')).toBeInTheDocument()
  expect(pmAI.plan).toHaveBeenCalledWith(question, undefined, undefined)
  expect(pmAI.triage).not.toHaveBeenCalled()
  expect(screen.getByRole('spinbutton', { name: '最多显示' })).toHaveValue(3)
  expect(screen.getByRole('checkbox', { name: '仅我的任务' })).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '查看工作重点' }))
  expect(pmAI.triage).toHaveBeenCalledWith({ projectIds: ['P007'], taskIds: [] }, 3, true)
  const result = within(await screen.findByRole('region', { name: '工作重点结果' }))
  expect(result.getByText(/显示 3 \/ 5 项/)).toHaveTextContent('2026-11-10')
  expect(result.getAllByRole('link').map((link) => link.textContent)).toEqual([
    '受阻事项', '逾期事项', '关键里程碑',
  ])
  expect(result.getByRole('link', { name: '受阻事项' })).toHaveAttribute(
    'href', '/projects/P007?tab=wbs&task=priority-0',
  )
  expect(result.getByText('已阻塞')).toBeInTheDocument()
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('同名任务须先选择，核对日期后只提交选中的任务', async () => {
  const question = '试验任务本周为何阻塞'
  const otherTask = { ...taskTarget, id: 'T2', projectId: 'P2', code: 'T2', projectName: '另一项目' }
  vi.mocked(pmAI.plan).mockResolvedValueOnce({
    ...agentPlan('explain'), status: 'clarify', projectIds: [], targets: [],
    choices: [taskTarget, otherTask], message: '检测到多个匹配任务，请选择一个任务',
  }).mockResolvedValueOnce({
    ...agentPlan('explain', taskTarget), startDate: '2026-11-09', endDate: '2026-11-10',
  })
  vi.mocked(pmAI.create).mockResolvedValue(run)
  render(<MemoryRouter><PMAssistant /></MemoryRouter>)
  await askAgent(question)
  expect(await screen.findByText('检测到多个匹配任务，请选择一个任务')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '按此范围分析' })).not.toBeInTheDocument()
  expect(pmAI.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '试验任务 · T1 · 测试项目' }))
  expect(await screen.findByText('核对操作和范围')).toBeInTheDocument()
  expect(pmAI.plan).toHaveBeenLastCalledWith(question, 'P1', 'T1')
  const end = screen.getByLabelText('分析结束日期')
  expect(end).toHaveValue('2026-11-10')
  fireEvent.change(end, { target: { value: '2026-11-11' } })
  expect(pmAI.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '按此范围分析' }))
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledWith({
    scenario: 'explain', projectIds: ['P1'], taskIds: ['T1'],
    startDate: '2026-11-09', endDate: '2026-11-11', question, material: '',
  }))
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('Agent 把选定任务和工作日数带入排期比较，等待比较确认', async () => {
  vi.mocked(pmAI.plan).mockResolvedValue({ ...agentPlan('schedule', taskTarget), delays: [2, 8] })
  vi.mocked(pmAI.compare).mockResolvedValue({ plans: [] })
  render(<MemoryRouter><PMAssistant /></MemoryRouter>)
  await askAgent('试验任务比较顺延 2 或 8 个工作日')
  fireEvent.click(await screen.findByRole('button', { name: '进入排期比较' }))
  expect(await screen.findByRole('textbox', { name: '顺延工作日方案' })).toHaveValue('2,8')
  expect(screen.getByRole('combobox', { name: '推演起点' })).toHaveValue('T1')
  expect(pmAI.compare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '比较排期方案' }))
  await waitFor(() => expect(pmAI.compare).toHaveBeenCalledWith('P1', 'T1', [2, 8], []))
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('记录慢响应不会覆盖最新选择，刷新读取当前记录', async () => {
  const second = { ...run, id: 'R2', result: { ...run.result!, summary: '第二份分析' } }
  let finishFirst: (value: PMAIRun) => void = () => {}
  vi.mocked(pmAI.list).mockResolvedValue({ items: [run, second], total: 2 })
  vi.mocked(pmAI.get).mockImplementation((id) => id === 'R1'
    ? new Promise((resolve) => { finishFirst = resolve })
    : Promise.resolve(second),
  )
  render(<MemoryRouter><PMAssistant projectId="P1" taskId="T1" /></MemoryRouter>)
  fireEvent.click(screen.getByText('项目 AI 助手'))
  await waitFor(() => expect(pmAI.get).toHaveBeenCalledWith('R1'))
  expect(pmAI.list).toHaveBeenCalledWith('P1', 'T1')
  fireEvent.change(screen.getByRole('combobox', { name: '分析记录' }), { target: { value: 'R2' } })
  expect(await screen.findByText('第二份分析')).toBeInTheDocument()
  await act(async () => finishFirst(run))
  expect(screen.queryByText('这项任务需要关注。')).not.toBeInTheDocument()
  vi.mocked(pmAI.get).mockResolvedValue({ ...second, result: { ...second.result!, summary: '第二份分析已刷新' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新记录' }))
  expect(await screen.findByText('第二份分析已刷新')).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '分析记录' })).toHaveValue('R2')
})

test('沿用失败会议的范围、日期和原文，只准备新分析', async () => {
  const previous: PMAIRun = {
    ...run, scenario: 'meeting', state: 'failed', result: null, error: '模型调用超时',
    request: { ...run.request, scenario: 'meeting', question: '整理行动项',
      material: '试验任务推进至 30%', startDate: '2026-11-01', endDate: '2026-11-10' },
  }
  vi.mocked(pmAI.get).mockResolvedValue(previous)
  render(<MemoryRouter initialEntries={['/projects?aiRun=R1']}><PMAssistant /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '沿用分析条件' }))
  expect(screen.getByRole('textbox', { name: '整理要求' })).toHaveValue('整理行动项')
  expect(screen.getByRole('textbox', { name: '会议文字' })).toHaveValue('试验任务推进至 30%')
  expect(screen.getByLabelText('开始日期')).toHaveValue('2026-11-01')
  expect(pmAI.create).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
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
