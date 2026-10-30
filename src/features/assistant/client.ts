import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'

export interface TaskInput { title: string; project: string; instructions: string }
export interface TaskSummary extends TaskInput { id: string; revision: number; createdAt: string; updatedAt: string; deletedAt: string | null; messageCount: number }
export interface AssistantMessage { id: string; role: 'user' | 'assistant'; content: string; context: string; model: string; mode: 'ai' | 'preview'; requestId: string; createdAt: string }
export interface AssistantArtifact { id: string; title: string; content: string; model: string; createdAt: string }
export interface AssistantTask extends TaskSummary { messages: AssistantMessage[]; artifacts: AssistantArtifact[] }
export interface TaskQuery { search?: string; project?: string; trashed?: boolean; offset?: number }
export interface TaskQuestion { requestId: string; question: string; context: string; modelProfileId?: string; data_sources?: string[] }
export interface AssistantClient {
  list(query?: TaskQuery): Promise<{ items: TaskSummary[]; total: number }>
  get(id: string): Promise<AssistantTask>
  create(input: TaskInput & { id: string }): Promise<AssistantTask>
  save(task: TaskSummary, input: TaskInput): Promise<AssistantTask>
  send(task: TaskSummary, input: TaskQuestion): Promise<AssistantTask>
  trash(task: TaskSummary): Promise<AssistantTask>
  restore(task: TaskSummary): Promise<AssistantTask>
}
const problem = (text: string, status = 0) => Object.assign(new Error(text), { status })
export function validateTask(input: TaskInput) {
  if (!input.title.trim() || input.title.length > 200 || input.project.length > 200 || input.instructions.length > 4000) throw problem('请填写任务名称（最多 200 字），项目最多 200 字，任务指引最多 4,000 字。')
}
const http = axios.create({ baseURL: `${API_BASE}/assistant/tasks`, withCredentials: true, timeout: 150000 })
http.interceptors.request.use(config => { if (config.data) config.data = snakeize(config.data); if (config.params) config.params = snakeize(config.params); return config })
http.interceptors.response.use(response => { response.data = camelize(response.data); return response }, (error: unknown) => {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined
  const detail = axios.isAxiosError(error) && typeof error.response?.data?.detail === 'string' ? error.response.data.detail : ''
  if (status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
  return Promise.reject(problem(status === 409 ? '任务已在其他页面更新。当前问题已保留，请刷新任务后核对并重试。' : status === 401 ? '登录已失效，请重新登录。' : [403, 422, 502, 503, 504].includes(status || 0) && detail ? detail : status === 422 ? '请检查任务内容和模型配置，再重新发送。' : status === 404 ? '任务或所选模型不存在，或当前账号无权访问。' : status === 403 ? '当前账号无法使用此功能，请先确认登录状态。' : '请求未完成，问题仍保留。请检查模型配置或连接后重试。', status))
})
export const assistantApi: AssistantClient = {
  list: async query => (await http.get('', { params: query })).data,
  get: async id => (await http.get(`/${encodeURIComponent(id)}`)).data,
  create: async input => (await http.post('', input)).data,
  save: async (task, input) => (await http.put(`/${encodeURIComponent(task.id)}`, { ...input, revision: task.revision })).data,
  send: async (task, input) => (await http.post(`/${encodeURIComponent(task.id)}/messages`, { ...input, revision: task.revision })).data,
  trash: async task => (await http.post(`/${encodeURIComponent(task.id)}/trash`, { revision: task.revision })).data,
  restore: async task => (await http.post(`/${encodeURIComponent(task.id)}/restore`, { revision: task.revision })).data,
}
export const taskSummary = (task: AssistantTask): TaskSummary => ({ id: task.id, title: task.title, project: task.project, instructions: task.instructions, revision: task.revision, createdAt: task.createdAt, updatedAt: task.updatedAt, deletedAt: task.deletedAt, messageCount: task.messageCount })
const intro = `# 欢迎使用 AI 助手\n\n这里是你的个人 AI 工作空间。把问题、资料和目标放在同一项任务中，持续讨论并整理成果。\n\n## 1. 创建任务\n\n在左侧新建任务，填写目标，并按项目归类。每项任务保留独立的对话记录和任务指引。\n\n## 2. 围绕资料讨论\n\n输入问题，或导入 Word、PDF、Markdown 资料，明确选择本轮要使用的材料。发送前可预览附带的正文。\n\n## 3. 留下可复用的成果\n\n右侧在「概览」和「产物」之间切换。每次回答都可以单独查看、复制，或导出为 Markdown。\n\n## 4. 选择自己的模型\n\n通过顶部「AI 模型设置」管理个人模型，沿用工作台现有设置。\n\n> 当前是本地交互演示，不调用外部模型。示例内容用于体验工作流程。`
function seed(): AssistantTask[] {
  const time = '2026-10-25T08:00:00.000Z', id = 'c0c19d0d-c4e8-4e47-bf17-5474f2baf877', reply = '874e5145-3532-4be5-a8f3-5b25fb156c02'
  const task: AssistantTask = { id, title: '认识 AI 助手工作空间', project: '使用入门', instructions: '', revision: 1, createdAt: time, updatedAt: time, deletedAt: null, messageCount: 2, messages: [
    { id: 'intro-question', role: 'user', content: '介绍一下如何使用 AI 助手。', context: '', model: 'enterprise', mode: 'preview', requestId: 'intro', createdAt: time },
    { id: reply, role: 'assistant', content: '欢迎使用 AI 助手。\n\n你可以把目标、资料和对话放在同一项任务中，让每一步思考都有迹可循。\n\n- **新建任务**：按项目整理独立对话。\n- **导入资料**：围绕文档持续讨论。\n- **留存产物**：查看、复制并导出每轮回答。\n\n已为你准备好一份使用指南，点击下方产物卡片查看。', context: '', model: '界面演示', mode: 'preview', requestId: 'intro', createdAt: time },
  ], artifacts: [{ id: reply, title: 'AI 助手使用指南', content: intro, model: '界面演示', createdAt: time }] }
  return [task]
}
function previewAnswer(question: string, context: string, instructions: string) {
  const quoted = question.slice(0, 1800).split('\n').map(line => `> ${line}`).join('\n')
  return `## 本轮任务\n\n${quoted}\n\n## 建议的推进方式\n\n1. 确认目标、使用场景和交付形式。\n2. 整理已有资料，区分原文事实、个人判断与待核实信息。\n3. 拆分工作步骤，为每一步列出需要补充的输入。\n4. 完成初稿后逐项复核，再导出或继续追问。\n\n## 可继续完善的草稿\n\n- **目标与范围**：根据本轮需求确定。\n- **已有材料**：${context ? '本轮已附带用户提供的资料；请逐项核对原文。' : '当前未附带资料，可导入文档或补充背景。'}\n- **关键分析**：记录观察、依据、差异与限制。\n- **下一步行动**：确认负责人、所需材料与验收标准。\n\n${instructions ? '## 任务指引\n\n' + instructions.split('\n').map(line => '> ' + line).join('\n') + '\n\n' : ''}> 本地演示：以上为流程示例，没有调用 AI 模型或检索真实资料。正式登录并配置模型后，可获得模型的实际回答。`
}
export function createPreviewAssistantClient(namespace: string, storage: Storage = localStorage): AssistantClient {
  const key = `mberp:assistant:preview:v1:${encodeURIComponent(namespace)}`
  const read = (): AssistantTask[] => {
    try {
      const raw = storage.getItem(key)
      if (!raw) return seed()
      const rows = JSON.parse(raw) as AssistantTask[]
      if (!Array.isArray(rows)) throw new Error()
      for (const row of rows) {
        validateTask(row)
        if (!row.id || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isFinite(Date.parse(row.updatedAt)) || !Number.isFinite(Date.parse(row.createdAt)) || row.deletedAt !== null && !Number.isFinite(Date.parse(row.deletedAt)) || !Array.isArray(row.messages) || !Array.isArray(row.artifacts) || row.messages.some(m => !m.id || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || typeof m.context !== 'string' || !m.requestId) || row.artifacts.some(a => !a.id || typeof a.content !== 'string' || typeof a.title !== 'string')) throw new Error()
      }
      return rows
    } catch { throw problem('无法读取本机任务，原有数据未被覆盖。请保留浏览器数据后重试。') }
  }
  const write = (rows: AssistantTask[]) => { try { storage.setItem(key, JSON.stringify(rows)) } catch { throw problem('浏览器无法保存任务，请保留当前问题和资料后重试。') } }
  const find = (rows: AssistantTask[], id: string) => { const row = rows.find(t => t.id === id); if (!row) throw problem('任务不存在。', 404); return row }
  const check = (current: AssistantTask, task: TaskSummary, trashed = false) => { if (current.revision !== task.revision || !!current.deletedAt !== trashed) throw problem('任务已在其他页面更新，请刷新后核对。', 409) }
  const change = (task: TaskSummary, patch: Partial<AssistantTask>, trashed = false) => {
    const rows = read(), current = find(rows, task.id); check(current, task, trashed)
    const saved = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() }
    write(rows.map(t => t.id === saved.id ? saved : t)); return structuredClone(saved)
  }
  return {
    list: async (query = {}) => {
      const search = query.search?.trim().toLocaleLowerCase() || '', offset = query.offset || 0
      const rows = read().filter(t => !!t.deletedAt === !!query.trashed && (query.project === undefined || t.project === query.project) && (!search || `${t.title}\n${t.project}`.toLocaleLowerCase().includes(search))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      return { items: rows.slice(offset, offset + 100).map(taskSummary), total: rows.length }
    },
    get: async id => structuredClone(find(read(), id)),
    create: async input => {
      validateTask(input)
      const rows = read(), old = rows.find(t => t.id === input.id)
      if (old) { if (!old.deletedAt && old.title === input.title && old.project === input.project && old.instructions === input.instructions) return structuredClone(old); throw problem('任务已创建，请刷新后核对。', 409) }
      const now = new Date().toISOString(), task = { ...input, revision: 1, createdAt: now, updatedAt: now, deletedAt: null, messageCount: 0, messages: [], artifacts: [] }
      write([task, ...rows]); return structuredClone(task)
    },
    save: async (task, input) => { validateTask(input); return change(task, input) },
    trash: async task => change(task, { deletedAt: new Date().toISOString() }),
    restore: async task => change(task, { deletedAt: null }, true),
    send: async (task, input) => {
      if (!input.question.trim() || input.question.length > 12000 || input.context.length > 20000 || !input.requestId || input.modelProfileId === 'retrieval') throw problem('问题最多 12,000 字，附带资料最多 20,000 字，请检查后重试。', 422)
      const current = find(read(), task.id)
      const replay = current.messages.find(m => m.role === 'user' && m.requestId === input.requestId)
      if (replay) {
        if (replay.content === input.question && replay.context === input.context && replay.model === (input.modelProfileId || 'enterprise')) return structuredClone(current)
        throw problem('同一次请求的内容已经改变，请重新发送。', 409)
      }
      check(current, task)
      if (current.messages.length >= 200) throw problem('此任务已达到 100 轮对话，请新建任务继续。', 422)
      const now = new Date().toISOString(), id = crypto.randomUUID(), content = previewAnswer(input.question, input.context, current.instructions)
      const messages: AssistantMessage[] = [...current.messages,
        { id: crypto.randomUUID(), role: 'user', content: input.question, context: input.context, model: input.modelProfileId || 'enterprise', mode: 'preview', requestId: input.requestId, createdAt: now },
        { id, role: 'assistant', content, context: '', model: '界面演示', mode: 'preview', requestId: input.requestId, createdAt: now },
      ]
      return change(task, { messages, messageCount: messages.length, artifacts: [...current.artifacts, { id, title: input.question.slice(0, 80), content, model: '界面演示', createdAt: now }] })
    },
  }
}
