import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import AssistantApp from './AssistantApp'
import { createPreviewAssistantClient, type AssistantRequest } from './client'
import type { ModelSettingsClient } from '../solutions/modelSettings'
import { readDraft, writeDraft } from './localDrafts'
import KnowledgeSources from './KnowledgeSources'
import { reportFromText } from '../solutions/reportImport'
import { materialSections, selectedMaterial } from './materialSections'

const models: ModelSettingsClient = { get: async () => ({ revision: 1, profiles: [], defaultProfileId: null }), save: vi.fn(), test: vi.fn() }
const composer = () => screen.getByRole('textbox', { name: '给 AI 助手的任务' })
beforeEach(() => localStorage.clear())
async function fixture() {
  const client = createPreviewAssistantClient(crypto.randomUUID())
  let task = await client.create({ id: crypto.randomUUID(), title: '成果与记忆', instructions: '', memory: '已有且已确认的目标' })
  task = await client.send(task, { requestId: crypto.randomUUID(), question: '先做一份初稿', context: '' })
  task = await client.save(task, { title: task.title, instructions: '', memory: task.memory, finalArtifactId: task.artifacts[0].id })
  const props = { client, modelClient: models, userName: '测试用户', namespace: 'curation', preview: true }
  const open = async () => { const view = render(<AssistantApp {...props} />); fireEvent.click(await screen.findByRole('button', { name: `打开任务：${task.title}` })); await screen.findByRole('heading', { name: task.title, level: 2 }); return view }
  return { client, task, props, open }
}

it('uses the chosen historical artifact as the base while preserving drafts and the final choice', async () => {
  const f = await fixture()
  f.client.preflight = vi.fn(async () => ({ ready: true, checks: [] }))
  const other = await f.client.send(f.task, { requestId: crypto.randomUUID(), question: '另写一份独立草稿', context: '' })
  const send = vi.spyOn(f.client, 'send')
  await f.open()
  const picker = screen.getByRole('combobox', { name: '选择任务产物' })
  fireEvent.change(picker, { target: { value: f.task.artifacts[0].id } })
  fireEvent.click(screen.getByRole('button', { name: '基于此稿修改' }))
  expect(screen.getByRole('button', { name: '取消基稿' })).toBeInTheDocument()
  expect(composer()).toHaveValue('')
  fireEvent.change(composer(), { target: { value: '改为更简短的版本' } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(send).toHaveBeenCalledOnce())
  const input = send.mock.calls[0][1]
  expect(input.baseArtifactId).toBe(f.task.artifacts[0].id)
  expect(f.client.preflight).toHaveBeenLastCalledWith(expect.objectContaining({ baseArtifactId: f.task.artifacts[0].id, answerMode: 'auto', question: '改为更简短的版本' }))
  expect(Object.keys(input)).not.toContain('baseContent')
  await waitFor(async () => expect((await f.client.get(f.task.id)).artifacts).toHaveLength(3))
  const saved = await f.client.get(f.task.id)
  expect(saved.artifacts.slice(0, 2)).toEqual(other.artifacts)
  expect(saved.artifacts[2].baseArtifactId).toBe(f.task.artifacts[0].id)
  expect(saved.finalArtifactId).toBe(f.task.artifacts[0].id)
  expect(screen.queryByRole('button', { name: '取消基稿' })).not.toBeInTheDocument()
})

it('cancels the base without changing the question, and never carries it into another task', async () => {
  const f = await fixture(), second = await f.client.create({ id: crypto.randomUUID(), title: '独立任务', instructions: '' })
  await f.open()
  fireEvent.click(screen.getByRole('button', { name: `打开任务：${f.task.title}` }))
  await screen.findByRole('button', { name: '基于此稿修改' })
  fireEvent.click(screen.getByRole('button', { name: '基于此稿修改' }))
  fireEvent.change(composer(), { target: { value: '保留问题' } })
  fireEvent.click(screen.getByRole('button', { name: '取消基稿' }))
  expect(composer()).toHaveValue('保留问题')
  fireEvent.click(screen.getByRole('button', { name: '基于此稿修改' }))
  fireEvent.click(screen.getByRole('button', { name: `打开任务：${second.title}` }))
  await screen.findByRole('heading', { name: second.title, level: 2 })
  expect(screen.queryByRole('button', { name: '取消基稿' })).not.toBeInTheDocument()
  expect(composer()).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: `打开任务：${f.task.title}` }))
  await screen.findByRole('heading', { name: f.task.title, level: 2 })
  expect(screen.getByRole('button', { name: '取消基稿' })).toBeInTheDocument()
  expect(composer()).toHaveValue('保留问题')
})

it('keeps the memory dialog editable on a revision conflict without overwriting newer memory', async () => {
  const f = await fixture(); await f.open()
  fireEvent.click(screen.getByRole('button', { name: '记入任务记忆' }))
  fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '待确认的新信息' } })
  fireEvent.change(screen.getByLabelText('记忆类型'), { target: { value: '待解决问题' } })
  expect(screen.getByRole('dialog')).toHaveTextContent('已有且已确认的目标')
  await f.client.save(f.task, { title: f.task.title, instructions: '', memory: '另一个页面确认的新目标' })
  fireEvent.click(screen.getByRole('button', { name: '确认并保存记忆' }))
  await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('其他页面更新'))
  expect(screen.getByLabelText('记忆内容')).toHaveValue('待确认的新信息')
  expect((await f.client.get(f.task.id)).memory).toBe('另一个页面确认的新目标')
})

it('does not persist a cancelled memory or a merge exceeding 6000 characters', async () => {
  const f = await fixture(); await f.open()
  fireEvent.click(screen.getByRole('button', { name: '记入任务记忆' }))
  fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '甲'.repeat(6000) } })
  expect(screen.getByRole('button', { name: '确认并保存记忆' })).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('超过 6,000 字')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
  expect((await f.client.get(f.task.id)).memory).toBe(f.task.memory)
})

it.each(['failed', 'cancelled'] as const)('restores the accepted base for a %s request and retries with the same parent', async status => {
  const f = await fixture(), baseArtifactId = f.task.artifacts[0].id
  let job: AssistantRequest | null = null
  f.client.activeRequest = vi.fn(async () => ({ request: job }))
  f.client.getRequest = vi.fn(async () => job!)
  f.client.submitRequest = vi.fn(async (_, input) => job = { requestId: input.requestId, taskId: f.task.id, question: input.question, context: '', baseArtifactId: input.baseArtifactId, status: 'running', stage: 'generating', partialContent: '', error: '', diagnosticId: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  await f.open()
  fireEvent.click(screen.getByRole('button', { name: '基于此稿修改' }))
  fireEvent.change(composer(), { target: { value: '修改原稿' } })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(composer()).toHaveValue(''))
  expect(screen.queryByRole('button', { name: '取消基稿' })).not.toBeInTheDocument()
  job = { ...job!, status }
  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(composer()).toHaveValue('修改原稿'))
  expect(readDraft('curation:preview', f.task.id)?.baseArtifactId).toBe(baseArtifactId)
  fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
  await waitFor(() => expect(f.client.submitRequest).toHaveBeenCalledTimes(2))
  expect(vi.mocked(f.client.submitRequest).mock.lastCall?.[1].baseArtifactId).toBe(baseArtifactId)
})

it('does not submit a base ID copied from a different task', async () => {
  const f = await fixture(), other = await f.client.create({ id: crypto.randomUUID(), title: '另一个任务', instructions: '' })
  writeDraft('curation:preview', other.id, { question: '试图修改', context: '', label: '', baseArtifactId: f.task.artifacts[0].id })
  const send = vi.spyOn(f.client, 'send'); await f.open()
  fireEvent.click(screen.getByRole('button', { name: `打开任务：${other.title}` }))
  await screen.findByRole('heading', { name: other.title, level: 2 })
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不属于当前任务'))
  expect(send).not.toHaveBeenCalled()
})

it('preserves extracted Markdown headings, paragraph boundaries, and exact selected offsets', () => {
  const text = '# 一级标题\n\n第一段\n\n## 二级标题\n\n' + '乙'.repeat(25000) + '\n\n### 三级标题\n\n结尾'
  const parsed = reportFromText('层级.md', '\uFEFF' + text.replaceAll('\n', '\r\n'), 'markdown')
  expect(parsed.extractedText).toBe(text)
  const parts = materialSections(parsed.extractedText)
  expect(parts.map(part => part.content).join('')).toBe(text)
  for (const part of parts) expect(text.slice(part.start, part.end)).toBe(part.content)
  expect(selectedMaterial('层级.md', parts, [parts[0].id])).toContain('# 一级标题\n\n第一段\n\n## 二级标题')
  expect(selectedMaterial('层级.md', parts, [parts[2].id])).not.toContain('# 一级标题')
})

it('shows captured source excerpts and passes only known character offsets to original text', () => {
  const onSource = vi.fn()
  render(<KnowledgeSources onSource={onSource} sources={[{ title: '证据原文', path: '/kb/one', kind: 'read', cited: true, citationStatus: 'path_matched', excerpts: [{ text: '已经读取的真实片段', offset: 83, length: 11, kind: 'read' }, { text: '只有检索片段的内容', offset: null, length: 10, kind: 'retrieved' }] }]} />)
  fireEvent.click(screen.getByText('查看本轮知识库来源'))
  expect(screen.getByText('已经读取的真实片段')).toBeInTheDocument()
  expect(screen.getByText('只有检索片段的内容')).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: '定位原文' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '定位原文' }))
  expect(onSource).toHaveBeenCalledWith('/kb/one', 83)
  expect(screen.getByText(/路径匹配仅说明/)).toBeInTheDocument()
})

it('imports the full structured text and requires explicit short-enough selections for a long document', async () => {
  const f = await fixture(); await f.open()
  fireEvent.click(screen.getByRole('button', { name: '添加任务资料' }))
  const text = '# 原始标题\n\n第一段保留空行\n\n## 子标题\n\n' + '甲'.repeat(30000)
  const file = { name: '长资料.md', size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer } as File
  fireEvent.change(screen.getByLabelText('导入助手资料文件'), { target: { files: [file] } })
  await screen.findByText(/资料已完整解析，请选择本轮所需片段/)
  expect(screen.getByRole('textbox', { name: '本轮资料正文' })).toHaveValue('')
  expect(screen.getByRole('dialog')).toHaveTextContent('并非 PDF 页码')
  const checkboxes = within(screen.getByRole('dialog')).getAllByRole('checkbox')
  fireEvent.click(checkboxes[0])
  expect((screen.getByRole('textbox', { name: '本轮资料正文' }) as HTMLTextAreaElement).value).toContain('# 原始标题\n\n第一段保留空行\n\n## 子标题')
  expect((screen.getByRole('textbox', { name: '本轮资料正文' }) as HTMLTextAreaElement).value).toContain('提取正文第 1–6000 字')
  for (const checkbox of checkboxes.slice(1, 4)) fireEvent.click(checkbox)
  expect(screen.getByRole('button', { name: '应用资料' })).toBeDisabled()
  fireEvent.click(checkboxes[3])
  fireEvent.click(screen.getByRole('button', { name: '应用资料' }))
  expect(readDraft('curation:preview', f.task.id)?.context.length).toBeLessThanOrEqual(20000)
})

it('asks for original data sources without enabling them when a knowledge artifact is chosen', async () => {
  const f = await fixture()
  const current = await f.client.send(f.task, { requestId: crypto.randomUUID(), question: '总结知识库论文', context: '', answerMode: 'knowledge', data_sources: ['knowledge'] })
  await f.open()
  fireEvent.change(screen.getByRole('combobox', { name: '选择任务产物' }), { target: { value: current.artifacts.at(-1)!.id } })
  fireEvent.click(screen.getByRole('button', { name: '基于此稿修改' }))
  expect(screen.getByText(/请在数据设置中启用后发送/)).toBeInTheDocument()
  expect(screen.getByLabelText('当前应用数据范围')).toHaveTextContent('未启用')
  fireEvent.change(composer(), { target: { value: '简化文字' } })
  const send = vi.spyOn(f.client, 'send')
  fireEvent.click(screen.getByRole('button', { name: '发送任务消息' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('需要启用原稿使用的应用数据源'))
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '取消基稿' })).toBeInTheDocument()
})
