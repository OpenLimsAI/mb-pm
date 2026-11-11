import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantApp from './AssistantApp'
import RequestProgressView from './RequestProgressView'
import Conversation from './Conversation'
import { createPreviewAssistantClient } from './client'
import type { AssistantRequest, AssistantTask, AssistantPreflight } from './client'
import type { ModelSettingsClient } from '../solutions/modelSettings'
import { readDraft, writeDraft } from './localDrafts'
import { materialSections, selectedMaterial } from './materialSections'
const models: ModelSettingsClient = { get: async () => ({ revision: 1, profiles: [], defaultProfileId: null }), save: vi.fn(), test: vi.fn() }
const composer = () => screen.getByRole('textbox', { name: '给 AI 助手的任务' })
async function setup() {
  const client = createPreviewAssistantClient(crypto.randomUUID())
  const task = await client.create({ id: crypto.randomUUID(), title: '改进验收任务', instructions: '' })
  const props = { client, modelClient: models, userName: '测试用户', preview: true, namespace: 'owner-a' }
  return { client, task, props }
}
async function opened(task: AssistantTask) { fireEvent.click(await screen.findByRole('button', { name: `打开任务：${task.title}` })); await screen.findByRole('heading', { name: task.title, level: 2 }); await waitFor(() => expect(composer()).toBeEnabled()) }
beforeEach(() => localStorage.clear())

describe('assistant recovery and curation', () => {
  it('recovers an unsent draft across remount and clears only that draft explicitly', async () => {
    const { task, props } = await setup(), first = render(<AssistantApp {...props} />)
    await opened(task)
    fireEvent.change(composer(), { target: { value: '尚未发送的分析问题' } })
    first.unmount()
    render(<AssistantApp {...props} />); await opened(task)
    expect(composer()).toHaveValue('尚未发送的分析问题')
    fireEvent.click(screen.getByRole('button', { name: '清空草稿' }))
    expect(composer()).toHaveValue('')
    expect(readDraft('owner-a:preview', task.id)).toBeUndefined()
  })
  it('never transfers another user draft when the account namespace changes', async () => {
    const { task, props } = await setup(), view = render(<AssistantApp {...props} />)
    await opened(task); fireEvent.change(composer(), { target: { value: '用户 A 未发草稿' } })
    view.rerender(<AssistantApp {...props} namespace="owner-b" />); await opened(task)
    expect(composer()).toHaveValue('')
    expect(readDraft('owner-b:preview', task.id)).toBeUndefined()
    expect(readDraft('owner-a:preview', task.id)?.question).toBe('用户 A 未发草稿')
  })
  it('blocks model submission when the send-time preflight rejects current configuration', async () => {
    const { client, task, props } = await setup(), send = vi.spyOn(client, 'send')
    client.preflight = vi.fn(async () => ({ ready: false, checks: [{ key: 'model', status: 'blocked' as const, message: '模型密钥未配置' }] }))
    render(<AssistantApp {...props} />); await opened(task)
    fireEvent.change(composer(), { target: { value: '我的研究问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('模型密钥未配置'))
    expect(send).not.toHaveBeenCalled(); expect(composer()).toHaveValue('我的研究问题')
    expect(client.preflight).toHaveBeenLastCalledWith(expect.objectContaining({ question: '我的研究问题', taskId: task.id, referenceMaterialAvailable: false }))
  })
  it('does not submit under a different account if a preflight resolves after an account switch', async () => {
    const { client, task, props } = await setup(), send = vi.spyOn(client, 'send')
    let finish!: () => void
    client.preflight = vi.fn(async (input): Promise<AssistantPreflight> => input.question ? new Promise(resolve => { finish = () => resolve({ ready: true, checks: [] }) }) : { ready: true, checks: [] })
    const view = render(<AssistantApp {...props} />); await opened(task)
    fireEvent.change(composer(), { target: { value: '原账号的问题' } }); fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
    await waitFor(() => expect(finish).toBeDefined())
    view.rerender(<AssistantApp {...props} namespace="different-user" />); await opened(task)
    await act(async () => finish())
    expect(send).not.toHaveBeenCalled(); expect(composer()).toHaveValue('')
  })
  it('curates a final artifact and saves only an explicitly edited and confirmed memory', async () => {
    const { client, task, props } = await setup()
    const row = await client.send(task, { requestId: crypto.randomUUID(), question: '整理研究目标', context: '' })
    render(<AssistantApp {...props} />); await opened(task)
    fireEvent.click(screen.getByRole('button', { name: '查看产物' }))
    fireEvent.click(screen.getByRole('button', { name: '设为最终成果' }))
    await waitFor(async () => expect((await client.get(task.id)).finalArtifactId).toBe(row.artifacts[0].id))
    fireEvent.click(screen.getByRole('button', { name: '记入任务记忆' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('第 1 轮回答')
    fireEvent.change(screen.getByLabelText('记忆类型'), { target: { value: '目标' } })
    fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '聚焦已确认的研究目标' } })
    expect((await client.get(task.id)).memory || '').toBe('')
    fireEvent.click(screen.getByRole('button', { name: '确认并保存记忆' }))
    await waitFor(async () => expect((await client.get(task.id)).memory).toContain('【目标 · 来源：第 1 轮回答'))
    const saved = await client.get(task.id)
    expect(saved.memory).toContain('聚焦已确认的研究目标')
    expect(saved.finalArtifactId).toBe(row.artifacts[0].id)
    fireEvent.click(screen.getByRole('button', { name: '任务设置' }))
    expect(screen.queryByRole('button', { name: '从已有提问整理摘要' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('任务摘要')).toHaveValue(saved.memory)
  })
  it('presents cancel, draft continuation and safe diagnostic copy separately from final answers', async () => {
    const job: AssistantRequest = { requestId: 'job', taskId: 'task', status: 'running', stage: 'generating', question: '私人问题', context: '私人材料', error: '', diagnosticId: 'a'.repeat(32), createdAt: new Date(Date.now() - 65000).toISOString(), updatedAt: new Date().toISOString(), partialContent: '未完成正文' }
    const cancel = vi.fn(async () => undefined), copy = vi.fn(), resume = vi.fn()
    const view = render(<RequestProgressView progress={{ phase: 'processing', job }} onCancel={cancel} />)
    expect(screen.getByText(/已用时 1 分/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '停止生成' })); await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    await act(async () => view.rerender(<RequestProgressView progress={{ phase: 'failed', job: { ...job, status: 'cancelled', canContinue: true } }} onContinue={resume} onCopyDiagnostic={copy} />))
    expect(screen.getByText('已停止生成')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '根据草稿重新整理' })); expect(resume).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '复制诊断信息' }))
    expect(copy.mock.calls[0][0]).toContain('请求编号：job'); expect(copy.mock.calls[0][0]).not.toContain('私人')
    expect(screen.queryByRole('button', { name: '导出 Markdown' })).not.toBeInTheDocument()
  })
  it('explains expired request input and does not offer a silent empty retry', () => {
    render(<RequestProgressView progress={{ phase: 'failed', job: { requestId: 'r', taskId: 't', status: 'failed', stage: 'failed', question: '', context: '', partialContent: '', error: '', diagnosticId: '', payloadExpired: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }} onRetry={vi.fn()} />)
    expect(screen.getByText(/临时输入已按保留策略清理/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
  })
  it('does not show empty retrieval statistics for a general response', () => {
    render(<Conversation messages={[{ id: 'm', role: 'assistant', content: '直接回答', context: '', model: 'model', mode: 'ai', requestId: 'r', createdAt: new Date().toISOString(), sourceSummary: {}, answerMode: 'general' }]} artifacts={[]} userName="我" onCopy={vi.fn()} onArtifact={vi.fn()} />)
    expect(screen.queryByText(/本轮目录返回/)).not.toBeInTheDocument()
  })
})

describe('local draft boundaries and material selection', () => {
  it('expires seven-day drafts and keeps account/environment namespaces separate', () => {
    writeDraft('user:live', 'task', { question: '草稿', context: '', label: '' })
    expect(readDraft('user:preview', 'task')).toBeUndefined()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 86400000)
    expect(readDraft('user:live', 'task')).toBeUndefined(); clock.mockRestore()
  })
  it('keeps all parsed text and reports exact selected character boundaries without silent truncation', () => {
    const input = '# 第一章\n\n' + '甲'.repeat(10000) + '\n\n# 第二章\n\n' + '乙'.repeat(18000)
    const parts = materialSections(input)
    expect(parts.map(part => part.content).join('')).toBe(input)
    const selection = selectedMaterial('研究.md', parts, [parts[2].id])
    expect(selection).toContain(`第 ${parts[2].start + 1}–${parts[2].end} 字`)
    expect(selection).toContain(parts[2].content)
    expect(selection).not.toContain(parts[0].content)
  })
})
