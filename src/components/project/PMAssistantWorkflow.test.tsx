import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PMAssistant } from './PMAssistant'
import { PMAIActions } from './PMAIActions'
import { pmAI, type PMAIContext, type PMAIRun } from '../../api/pmAI'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import { users } from '../../mock'

vi.mock('../../api/pmAI', () => ({ pmAI: { context: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), resume: vi.fn(), cancel: vi.fn(), plan: vi.fn(), triage: vi.fn(), preview: vi.fn(), apply: vi.fn(), receipts: vi.fn() } }))
vi.mock('../../data/bootstrap', () => ({ refreshAllData: vi.fn().mockResolvedValue(undefined) }))

const source: PMAIRun['source'] = { schemaVersion: 1, asOf: '2026-11-15', complete: true, refs: [{ id: 'task:T1', type: 'task', entityId: 'T1', title: '试验任务', href: '/projects/P1?task=T1', observedAt: '2026-11-15', revision: 1 }] }
const context: PMAIContext = { schemaVersion: 1, scope: { projectIds: ['P1'], taskIds: ['T1'] }, asOf: '2026-11-15', timezone: 'Asia/Shanghai', projects: [{ id: 'P1', code: 'P1', name: '测试项目', ownerId: 'owner' }], tasks: [{ id: 'T1', code: 'T1', name: '试验任务', projectId: 'P1', subProjectId: 'S1', ownerId: 'owner', revision: 1 }], members: [{ id: 'owner', name: '负责人' }], subProjects: [{ id: 'S1', projectId: 'P1', name: '试验阶段' }], registerEntries: [], source }
function workflowRun(patch: Partial<PMAIRun> = {}): PMAIRun {
  return {
    id: 'W1', scenario: 'weekly', state: 'paused', createdAt: '2026-11-15T10:00:00Z', error: '', source, result: null,
    scope: { projectIds: ['P1'], taskIds: ['T1'] },
    request: { scenario: 'weekly', projectIds: ['P1'], taskIds: ['T1'], startDate: '2026-11-09', endDate: '2026-11-15', question: '整理本周周报', material: '原始完整材料' },
    workflow: { version: 1, phase: 'analysis', completedSteps: 1, totalSteps: 3, callsUsed: 12, callLimit: 64, tokenBudgetUsed: 12000, window: { number: 1, callsUsed: 12, callLimit: 12, tokenBudgetUsed: 12000, tokenLimit: 131072, secondsLimit: 600 }, pauseReason: 'window_call_limit', canResume: true, steps: [{ id: 'a', title: '核对试验阶段', kind: 'analysis', state: 'completed', depth: 0, calls: 1, durationMs: 100 }, { id: 'b', title: '整理申报阶段', kind: 'analysis', state: 'pending', depth: 0, calls: 0, durationMs: 0 }, { id: 'c', title: '汇总周报', kind: 'synthesis', state: 'pending', depth: 0, calls: 0, durationMs: 0 }], sections: [{ title: '试验阶段摘要', summary: '试验阶段已核对，待确认条件。', evidenceIds: ['task:T1'] }] },
    ...patch,
  }
}
function openRun(run = workflowRun(), props: { projectId?: string; taskId?: string; disabled?: boolean } = {}) {
  vi.mocked(pmAI.get).mockResolvedValue(run)
  return render(<MemoryRouter initialEntries={['/?aiRun=W1']}><PMAssistant standalone {...props} /></MemoryRouter>)
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(pmAI.resume).mockReset()
  vi.mocked(pmAI.plan).mockReset()
  vi.mocked(pmAI.create).mockReset()
  vi.mocked(pmAI.cancel).mockReset()
  vi.mocked(pmAI.preview).mockReset()
  vi.mocked(pmAI.apply).mockReset()
  vi.mocked(pmAI.context).mockResolvedValue(context)
  vi.mocked(pmAI.list).mockResolvedValue({ items: [], total: 0 })
  vi.mocked(pmAI.receipts).mockResolvedValue([])
  sessionStorage.clear()
  useDataStore.setState({ mode: 'api', businessDate: '2026-11-15' })
  useAuth.setState({ currentUser: users.find(user => user.role === 'admin')! })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('真实步骤、当前处理及阶段摘要可查看，阶段草稿不展示成最终报告或业务操作', async () => {
  const run = workflowRun({ state: 'running' })
  run.workflow!.steps[1].state = 'running'
  // Even an unexpected intermediate result must not expose final-only actions.
  run.result = { summary: '不可作为最终报告的阶段草稿', findings: [], draftActions: [{ kind: 'task_update', taskId: 'T1', progress: 50, reason: '阶段建议', evidenceIds: ['task:T1'] }] }
  openRun(run)
  expect(await screen.findByText('已完成 1 / 3 步')).toBeVisible()
  expect(screen.getByText('当前步骤：整理申报阶段')).toBeVisible()
  expect(screen.getByRole('progressbar', { name: '已完成步骤' })).toHaveAttribute('value', '1')
  fireEvent.click(screen.getByText('查看处理步骤', { selector: 'summary' }))
  expect(screen.getByText((_, element) => element?.tagName === 'LI' && element.textContent === '已完成 · 核对试验阶段')).toBeVisible()
  fireEvent.click(screen.getByText('查看已保存的阶段结果（1）', { selector: 'summary' }))
  expect(screen.getByText('以下是已完成步骤的摘要，尚未形成最终报告。')).toBeVisible()
  expect(screen.getByText('试验阶段已核对，待确认条件。')).toBeVisible()
  expect(screen.getAllByRole('link', { name: '试验任务' })[0]).toHaveAttribute('href', '/projects/P1?task=T1')
  expect(screen.queryByText('不可作为最终报告的阶段草稿')).not.toBeInTheDocument()
  expect(screen.queryByText(/核对修改/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '复制草稿' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '导出草稿' })).not.toBeInTheDocument()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('暂停保留进度，刷新历史和原记录不继续调用模型，只有明确继续才resume同run', async () => {
  const run = workflowRun()
  openRun(run)
  expect(await screen.findByRole('heading', { name: '进度已保存' })).toBeVisible()
  expect(screen.getByText('本轮已达到模型请求额度，已保存进度。')).toBeVisible()
  expect(pmAI.resume).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '更新状态' }))
  await waitFor(() => expect(pmAI.get).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: '历史' }))
  await screen.findByRole('button', { name: '刷新历史' })
  fireEvent.click(screen.getByRole('button', { name: '刷新历史' }))
  expect(pmAI.resume).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
  vi.mocked(pmAI.resume).mockResolvedValue({ ...run, state: 'running' })
  fireEvent.click(screen.getByRole('button', { name: '继续处理' }))
  await waitFor(() => expect(pmAI.resume).toHaveBeenCalledExactlyOnceWith('W1'))
  expect(await screen.findByRole('heading', { name: '正在整理' })).toBeVisible()
  expect(screen.getByText('已完成 1 / 3 步')).toBeVisible()
  expect(pmAI.plan).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('暂停不自动轮询或触发恢复', async () => {
  openRun()
  await screen.findByRole('button', { name: '继续处理' })
  vi.useFakeTimers()
  await act(async () => { vi.advanceTimersByTime(20_000) })
  expect(pmAI.get).toHaveBeenCalledOnce()
  expect(pmAI.resume).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('workflow累计次数与最近步骤的生成诊断分开标注，不把单步次数当总量', async () => {
  openRun(workflowRun({ generation: { version: 1, attempts: [{ number: 1, outputBudget: 8192, finishReason: null, errorCode: 'model_network', usage: {}, durationMs: 10 }], recoveryAttempted: false, recovered: false, errorCode: 'model_network' } }))
  fireEvent.click(await screen.findByText('查看诊断', { selector: 'summary' }))
  expect(screen.getByText('最近步骤模型请求次数：1 · 最近步骤自动恢复：未触发')).toBeVisible()
  fireEvent.click(screen.getByText('查看处理步骤', { selector: 'summary' }))
  expect(screen.getByText(/本次已请求模型 12 \/ 64 次/)).toBeVisible()
})

test.each([
  ['process_interrupted', '处理曾被中断，已完成步骤已保存。'],
  ['window_token_limit', '本轮已达到模型用量额度，已保存进度。'],
  ['window_time_limit', '本轮已达到处理时限，已保存进度。'],
  ['output_limit', '当前步骤的模型结果仍不完整，已保存此前完成的步骤。'],
  ['model_output_format', '当前步骤的结果未通过格式校验，已保存此前完成的步骤。'],
  ['model_network', '当前步骤连接模型服务时发生网络异常或超时，已保存此前完成的步骤。'],
])('暂停明确说明原因并允许显式继续（%s）', async (reason, message) => {
  const run = workflowRun(); run.workflow!.pauseReason = reason
  openRun(run)
  expect(await screen.findByText(message)).toBeVisible()
  expect(screen.getByRole('button', { name: '继续处理' })).toBeEnabled()
  expect(pmAI.resume).not.toHaveBeenCalled()
})

test('继续响应丢失时保留原记录，可幂等重试同run且不会创建新run', async () => {
  const run = workflowRun()
  vi.mocked(pmAI.resume).mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce({ ...run, state: 'queued' })
  openRun(run)
  fireEvent.click(await screen.findByRole('button', { name: '继续处理' }))
  expect(await screen.findByText(/暂未确认继续处理的结果/)).toBeVisible()
  expect(screen.getByText('已完成 1 / 3 步')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '继续处理' }))
  await waitFor(() => expect(pmAI.resume).toHaveBeenCalledTimes(2))
  expect(vi.mocked(pmAI.resume).mock.calls).toEqual([['W1'], ['W1']])
  expect(await screen.findByRole('heading', { name: '等待整理' })).toBeVisible()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('响应丢失后可只刷新原run确认已运行，无需重复付费请求', async () => {
  const run = workflowRun()
  vi.mocked(pmAI.resume).mockRejectedValue(new Error('network timeout'))
  openRun(run)
  fireEvent.click(await screen.findByRole('button', { name: '继续处理' }))
  await screen.findByText(/暂未确认继续处理的结果/)
  vi.mocked(pmAI.get).mockResolvedValue({ ...run, state: 'running' })
  fireEvent.click(screen.getByRole('button', { name: '更新状态' }))
  expect(await screen.findByRole('heading', { name: '正在整理' })).toBeVisible()
  expect(screen.queryByText(/暂未确认继续处理的结果/)).not.toBeInTheDocument()
  expect(pmAI.resume).toHaveBeenCalledOnce()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('正在刷新同一记录时禁止继续，避免旧读取覆盖新恢复状态', async () => {
  openRun()
  await screen.findByRole('button', { name: '继续处理' })
  let finish: (value: PMAIRun) => void = () => {}
  vi.mocked(pmAI.get).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: '更新状态' }))
  expect(screen.getByRole('button', { name: '继续处理' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '继续处理' }))
  expect(pmAI.resume).not.toHaveBeenCalled()
  await act(async () => finish(workflowRun()))
  expect(screen.getByRole('button', { name: '继续处理' })).toBeEnabled()
})

test('未保存进展时可暂停后台处理并保存阶段结果，继续处理仍被禁止', async () => {
  const run = workflowRun({ state: 'running' })
  vi.mocked(pmAI.cancel).mockResolvedValue({ ...run, state: 'paused', workflow: { ...run.workflow!, pauseReason: 'user_stopped' } })
  openRun(run, { disabled: true })
  fireEvent.click(await screen.findByRole('button', { name: '暂停处理' }))
  expect(await screen.findByRole('button', { name: '继续处理' })).toBeDisabled()
  expect(screen.getByText('已按你的操作暂停处理，已完成步骤已保存。')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '继续处理' }))
  expect(pmAI.resume).not.toHaveBeenCalled()
  expect(pmAI.cancel).toHaveBeenCalledExactlyOnceWith('W1')
  expect(screen.queryByRole('button', { name: '暂停处理' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '停止整理' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('查看已保存的阶段结果（1）', { selector: 'summary' }))
  expect(screen.getByText('试验阶段已核对，待确认条件。')).toBeVisible()
})

test('旧无workflow运行记录仍以停止整理取消，不误称保留分步检查点', async () => {
  const run = workflowRun({ state: 'running', workflow: null })
  vi.mocked(pmAI.cancel).mockResolvedValue({ ...run, state: 'cancelled' })
  openRun(run)
  fireEvent.click(await screen.findByRole('button', { name: '停止整理' }))
  expect(await screen.findByRole('heading', { name: '这次整理已停止' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '继续处理' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '暂停处理' })).not.toBeInTheDocument()
  expect(pmAI.cancel).toHaveBeenCalledExactlyOnceWith('W1')
})

test.each([
  [{ projectIds: ['P1', 'P2'], taskIds: [] }, { projectId: 'P1' }],
  [{ projectIds: ['P1'], taskIds: ['T1', 'T2'] }, { projectId: 'P1', taskId: 'T1' }],
])('固定项目或任务页不能继续超出原页面范围的历史分析（%j）', async (scope, props) => {
  openRun(workflowRun({ scope }), props)
  fireEvent.click(await screen.findByRole('button', { name: '继续处理' }))
  expect(await screen.findByText(/请从原范围打开后继续处理/)).toBeVisible()
  expect(pmAI.resume).not.toHaveBeenCalled()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('继续过程提出新问题后，原run的迟到响应不覆盖新结果也不取消后台任务', async () => {
  const run = workflowRun()
  let finish: (value: PMAIRun) => void = () => {}
  vi.mocked(pmAI.resume).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.mocked(pmAI.plan).mockResolvedValue({ status: 'ready', scenario: 'weekly', projectIds: ['P1'], taskIds: ['T1'], targets: [], choices: [], message: '', limit: 5 })
  vi.mocked(pmAI.create).mockResolvedValue({ ...run, id: 'W2', state: 'succeeded', workflow: null, result: { summary: '新问题的独立结果', findings: [], draftActions: [] } })
  openRun(run)
  fireEvent.click(await screen.findByRole('button', { name: '继续处理' }))
  fireEvent.click(screen.getByRole('button', { name: '新问题' }))
  fireEvent.change(screen.getByRole('textbox', { name: '告诉我你想做什么' }), { target: { value: '只整理本周风险' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText('新问题的独立结果')).toBeVisible()
  await act(async () => finish({ ...run, state: 'running' }))
  expect(screen.getByText('新问题的独立结果')).toBeVisible()
  expect(screen.queryByRole('heading', { name: '正在整理' })).not.toBeInTheDocument()
  expect(pmAI.cancel).not.toHaveBeenCalled()
  expect(pmAI.create).toHaveBeenCalledOnce()
})

test('权限拒绝继续时显示服务端说明，不当作断网重试或创建新run', async () => {
  vi.mocked(pmAI.resume).mockRejectedValue({ isAxiosError: true, response: { status: 403, data: { detail: '当前账号不可继续该项目分析' } } })
  openRun()
  fireEvent.click(await screen.findByRole('button', { name: '继续处理' }))
  expect(await screen.findByText('当前账号不可继续该项目分析')).toBeVisible()
  expect(screen.queryByText(/暂未确认继续处理的结果/)).not.toBeInTheDocument()
  expect(pmAI.resume).toHaveBeenCalledOnce()
  expect(pmAI.create).not.toHaveBeenCalled()
})

test('不可继续的快照记录只允许明确新建，仍保留原日期范围和材料', async () => {
  const run = workflowRun(); run.workflow!.pauseReason = 'snapshot_changed'; run.workflow!.canResume = false
  vi.mocked(pmAI.create).mockResolvedValue({ ...run, id: 'W2', state: 'queued', workflow: null })
  openRun(run)
  expect(await screen.findByText('本次整理的数据快照已变化，无法继续当前记录。')).toBeVisible()
  expect(screen.queryByRole('button', { name: '继续处理' })).not.toBeInTheDocument()
  expect(pmAI.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }))
  await waitFor(() => expect(pmAI.create).toHaveBeenCalledExactlyOnceWith(run.request))
  expect(pmAI.resume).not.toHaveBeenCalled()
})

test('全部步骤完成后展示分段报告和最终结果，证据入口沿用真实任务链接', async () => {
  const run = workflowRun({ state: 'succeeded', result: { summary: '最终周报结果', findings: [], draftActions: [] } })
  run.workflow = { ...run.workflow!, completedSteps: 3, phase: 'complete', canResume: false, pauseReason: null, steps: run.workflow!.steps.map(step => ({ ...step, state: 'completed' })) }
  openRun(run)
  expect(await screen.findByText('最终周报结果')).toBeVisible()
  const sections = screen.getByText('查看完整分段报告（1）', { selector: 'summary' })
  expect(sections).toBeVisible()
  expect(sections.parentElement).not.toHaveAttribute('open')
  expect(screen.getByText('试验阶段已核对，待确认条件。')).not.toBeVisible()
  fireEvent.click(sections)
  expect(screen.getByText('试验阶段已核对，待确认条件。')).toBeVisible()
  expect(screen.queryByText(/尚未形成最终报告/)).not.toBeInTheDocument()
  expect(screen.getAllByRole('link', { name: '试验任务' })[0]).toHaveAttribute('href', '/projects/P1?task=T1')
  expect(screen.queryByRole('button', { name: '继续处理' })).not.toBeInTheDocument()
})

test('最终周报复制和导出包含每一段报告和证据，编辑不修改原保存结果', async () => {
  const run = workflowRun({ state: 'succeeded', result: { summary: '最终摘要', findings: [], draftActions: [] } })
  run.workflow!.sections.push({ title: '申报阶段摘要', summary: '申报阶段另有明确待办。', evidenceIds: ['task:T1'] })
  openRun(run)
  await screen.findByText('最终摘要')
  const writeText = vi.fn().mockResolvedValue(undefined)
  const testNavigator = Object.create(navigator)
  Object.defineProperty(testNavigator, 'clipboard', { value: { writeText } })
  vi.stubGlobal('navigator', testNavigator)
  fireEvent.click(screen.getByRole('button', { name: '复制草稿' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
  const copied = writeText.mock.calls[0][0] as string
  expect(copied).toContain('最终摘要')
  expect(copied).toContain('试验阶段已核对，待确认条件。')
  expect(copied).toContain('申报阶段另有明确待办。')
  expect(copied).toContain('依据：试验任务（/projects/P1?task=T1）')
  let downloaded: Blob | undefined
  const OriginalURL = URL
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:report' } static revokeObjectURL() {} })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fireEvent.click(screen.getByRole('button', { name: '导出草稿' }))
  const exported = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(downloaded!) })
  expect(exported).toBe(copied)
  fireEvent.click(screen.getByRole('button', { name: '编辑草稿' }))
  expect(screen.getByRole('textbox', { name: '编辑周报草稿' })).toHaveValue(copied)
  fireEvent.change(screen.getByRole('textbox', { name: '编辑周报草稿' }), { target: { value: '本地修改' } })
  expect(run.workflow!.sections).toHaveLength(2)
  expect(run.result!.summary).toBe('最终摘要')
})

function manyActions(): PMAIRun {
  return workflowRun({ state: 'succeeded', result: { summary: '会议共提取25项修改', findings: [], draftActions: Array.from({ length: 25 }, (_, index) => ({ kind: 'task_update' as const, taskId: 'T1', expectedRevision: 1, notes: `修改${index + 1}`, reason: `原因${index + 1}`, evidenceIds: ['task:T1'] })) } })
}
function mockPreview() {
  vi.mocked(pmAI.preview).mockImplementation(async (_id, actions) => ({ actions, confirmationToken: `token-${actions[0].notes}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), changes: actions.map((action, index) => ({ kind: action.kind, entityId: `T${index}`, title: action.notes ?? '任务', before: { notes: '' }, after: { notes: action.notes }, evidenceIds: action.evidenceIds })) }))
}

test('25项会议修改全部按12/12/1分批核对，切换保留编辑且不会提交超限或自动写入', async () => {
  mockPreview()
  render(<MemoryRouter><PMAIActions run={manyActions()} context={context} userId="owner" disabled={false} /></MemoryRouter>)
  expect(screen.getByText('共 25 项待核对修改，分 3 批处理；每批最多 12 项，分别预览并确认。')).toBeVisible()
  const batch = screen.getByRole('combobox', { name: '操作批次' })
  expect(screen.getByRole('option', { name: '第3批（25–25项）' })).toBeInTheDocument()
  expect(screen.getAllByRole('checkbox')).toHaveLength(12)
  expect(screen.getByRole('button', { name: '添加操作' })).toBeDisabled()
  fireEvent.change(screen.getAllByRole('textbox', { name: '操作原因' })[0], { target: { value: '保留本地修改' } })
  fireEvent.click(screen.getByRole('button', { name: '预览操作差异' }))
  await waitFor(() => expect(pmAI.preview).toHaveBeenCalledOnce())
  expect(vi.mocked(pmAI.preview).mock.calls[0][1]).toHaveLength(12)
  expect(vi.mocked(pmAI.preview).mock.calls[0][1][0].reason).toBe('保留本地修改')
  fireEvent.change(batch, { target: { value: '1' } })
  expect(screen.getAllByRole('checkbox')).toHaveLength(12)
  fireEvent.click(screen.getByRole('button', { name: '预览操作差异' }))
  await waitFor(() => expect(pmAI.preview).toHaveBeenCalledTimes(2))
  expect(vi.mocked(pmAI.preview).mock.calls[1][1][0].notes).toBe('修改13')
  fireEvent.change(batch, { target: { value: '2' } })
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '预览操作差异' }))
  await waitFor(() => expect(pmAI.preview).toHaveBeenCalledTimes(3))
  expect(vi.mocked(pmAI.preview).mock.calls[2][1]).toHaveLength(1)
  expect(vi.mocked(pmAI.preview).mock.calls[2][1][0].notes).toBe('修改25')
  fireEvent.change(batch, { target: { value: '0' } })
  expect(screen.getAllByRole('textbox', { name: '操作原因' })[0]).toHaveValue('保留本地修改')
  expect(pmAI.apply).not.toHaveBeenCalled()
})

test('不同批次的待确认token隔离，回到首批只显式重试其原确认', async () => {
  mockPreview()
  vi.mocked(pmAI.apply).mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce({ receiptId: 'receipt-first', replayed: true, results: [], verified: true })
  render(<MemoryRouter><PMAIActions run={manyActions()} context={context} userId="owner" disabled={false} /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '预览操作差异' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认应用 12 项操作' }))
  await screen.findByRole('button', { name: '重试本次确认' })
  fireEvent.change(screen.getByRole('combobox', { name: '操作批次' }), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: '预览操作差异' }))
  await screen.findByRole('button', { name: '确认应用 12 项操作' })
  expect(pmAI.apply).toHaveBeenCalledExactlyOnceWith('W1', 'token-修改1')
  fireEvent.change(screen.getByRole('combobox', { name: '操作批次' }), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: '重试本次确认' }))
  expect(await screen.findByText('操作已完成并核验 · 回执 receipt-first')).toBeVisible()
  expect(vi.mocked(pmAI.apply).mock.calls).toEqual([['W1', 'token-修改1'], ['W1', 'token-修改1']])
})

test('未保存进展时所有批次的预览和确认都不可执行', async () => {
  render(<MemoryRouter><PMAIActions run={manyActions()} context={context} userId="owner" disabled /></MemoryRouter>)
  expect(screen.getByRole('button', { name: '预览操作差异' })).toBeDisabled()
  fireEvent.change(screen.getByRole('combobox', { name: '操作批次' }), { target: { value: '2' } })
  expect(screen.getByRole('button', { name: '预览操作差异' })).toBeDisabled()
  expect(pmAI.preview).not.toHaveBeenCalled()
  expect(pmAI.apply).not.toHaveBeenCalled()
})
