import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { addDays, format } from 'date-fns'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { PMAssistant } from './PMAssistant'
import { PMAIActions } from './PMAIActions'
import { PMAIScheduleCompare } from './PMAIScheduleCompare'
import { pmAI, type PMAIContext, type PMAIRun } from '../../api/pmAI'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { subProjects, tasks, users, TODAY } from '../../mock'
import { refreshAllData } from '../../data/bootstrap'

vi.mock('../../api/pmAI', () => ({
  pmAI: {
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
  vi.mocked(pmAI.get).mockResolvedValue(run)
  render(
    <MemoryRouter initialEntries={['/projects/P1?aiRun=R1']}>
      <PMAssistant projectId="P1" />
    </MemoryRouter>,
  )
  expect(await screen.findByText('这项任务需要关注。')).toBeInTheDocument()
  expect(pmAI.get).toHaveBeenCalledWith('R1')
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
