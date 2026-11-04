import { createPreviewNotesClient } from '../notes/client'
import type { ReportCollaboration, ReportNoteLink } from './types'
import { previewCapabilities, previewProvenance, previewWebAnswer } from '../answerModes/preview'
import type { Answer, KnowledgeSource, Solution, SolutionClient, SolutionInput, Version, ReportTemplate, TopicMetadata } from './types'
import { emptySolution } from './template'
import { exportPreview } from './export'
import { libraryEmbedUrl, validLibraryPath } from './libraryEmbed'

const now = () => new Date().toISOString()
const uid = () => crypto.randomUUID()
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
interface DemoState { collaboration?: Record<string, ReportCollaboration>; noteLinks?: Record<string, ReportNoteLink[]>; templates?: ReportTemplate[]; topics?: Record<string, TopicMetadata[]>; trash?: { solution: Solution; deletedAt: string }[]; solutions: Solution[]; sources: KnowledgeSource[]; versions: Record<string, Version[]>; answers: Record<string, Answer[]> }

function initialState(userId: string, userName: string): DemoState {
  const input = emptySolution('缓冲体系选择与验证报告')
  input.projectName = '示例研发项目'; input.productName = '示例蛋白制剂'
  const paragraphs = [
    '研究目标\n比较候选缓冲体系的适用条件，形成下一轮实验的验证计划。\n\n适用范围\n本报告处于研究阶段。本文及右侧资料均为交互演示内容，不对应真实药物、论文或实验结果。\n\n本轮待回答\n• 现有资料中有哪些相关观察？\n• 不同研究条件之间有哪些差异？\n• 哪些判断仍需要实验验证？',
    '文献线索\n从右侧选择论文资料，查看研究条件和结论，再将相关片段引用至本章。\n\n实践基础\n同时查看成功与失败记录，明确样品、设备和观察方法的差异。不要直接把其他条件下的观察推广至本项目。',
    '候选思路\n记录各候选体系的选择理由，区分文献记载、实践观察与专家判断。\n\n专家判断\n当前证据不足以确定最终配方。先完成资料对比，再确认实验变量与验证方法。',
    '拟研究条件\n列出影响结果的工艺因素，并说明需要保持一致的实验条件。具体参数由项目专家确认。',
    '验证事项\n1. 核对资料的实验条件及原始记录。\n2. 明确需要比较的候选体系及观察指标。\n3. 完成实验后记录结果和不确定性。',
    '证据缺口\n资料中的观察条件可能与当前项目不一致。\n\n待解决问题\n关键选择仍缺少本项目的直接实验依据。',
    '专家结论\n待完成资料核验及实验验证后填写。\n\n选择依据\n请保留采用和不采用某种思路的理由。',
  ]
  input.sections.forEach((section, i) => { section.content = paragraphs[i] })
  input.formula = [
    { id: uid(), material: '候选缓冲体系 A', purpose: '缓冲体系', specification: '待确认', amount: '', unit: '', basis: '每批', range: '', rationale: '待对比文献与实践证据', evidenceIds: [], verification: 'pending' },
    { id: uid(), material: '候选稳定组分', purpose: '研究变量', specification: '待确认', amount: '', unit: '', basis: '每批', range: '', rationale: '待专家确认必要性', evidenceIds: [], verification: 'pending' },
  ]
  const solution: Solution = { ...input, id: 'demo-solution', ownerId: userId, ownerName: userName, status: 'draft', revision: 1, version: 1, updatedAt: now(), reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true }
  const base = { projectName: '示例研发项目', url: '', version: '1', updatedAt: now(), date: '2026-10-23', authors: '演示资料，无真实作者', locator: '资料正文' }
  const sources: KnowledgeSource[] = [
    { ...base, id: 'demo-paper', kind: 'paper', title: '缓冲体系筛选的研究要点', tags: ['缓冲体系', '文献', '演示'], content: '【演示资料，不是真实论文】\n\n研究范围\n本示例用于展示如何阅读论文、保留研究条件与引用来源。\n\n相关知识\n比较缓冲体系时，应在笔记中记录研究对象、实验条件及观察方法。来自不同实验条件的结论应分开呈现。\n\n局限\n本资料未包含真实药物数据，不能作为配方参数依据。' },
    { ...base, id: 'demo-practice', kind: 'practice', title: '候选体系比较的实践记录', tags: ['缓冲体系', '实践', '演示'], content: '【演示资料，不是真实实验】\n\n实践记录\n项目：示例研发项目；实验标识：DEMO-001。\n记录应保留样品条件、操作步骤、观察结果和原始附件位置。\n\n失败与差异\n若观察与文献不同，先核对样品和实验方法的差异，再记录专家判断及下一步验证事项。\n\n待验证\n本示例没有实际配方用量或实验结论。' },
    { ...base, id: 'demo-note', kind: 'note', title: '专家笔记  证据与假设的区分', tags: ['专家判断', '证据', '演示'], content: '【演示笔记】\n\n文献记载、实践观察与专家推断应分别标识。\n每项配方选择写明支持或反对的依据、适用条件及待验证事项。\n找不到相关知识时，记录证据缺口，并补充检索或安排验证。' },
  ]
  return { solutions: [solution], sources, versions: {}, answers: {} }
}

export function createDemoClient(namespace: string, userId: string, userName: string, storage: Storage = window.localStorage): SolutionClient {
  const key = `mberp:solutions:preview:v1:${namespace}`
  function read(): DemoState {
    const saved = storage.getItem(key)
    if (!saved) { const state = initialState(userId, userName); write(state); return state }
    try {
      const data = JSON.parse(saved) as DemoState
      if (!Array.isArray(data.solutions) || !Array.isArray(data.sources) || !data.versions || !data.answers) throw new Error()
      return data
    } catch { throw new Error('预览草稿无法读取。请保留浏览器数据，联系维护者处理。') }
  }
  function write(state: DemoState) { try { storage.setItem(key, JSON.stringify(state)) } catch { throw new Error('浏览器无法保存预览草稿，可能存储空间不足。请先导出备份。') } }
  function get(state: DemoState, id: string) { const s = state.solutions.find(item => item.id === id); if (!s) throw new Error('报告不存在'); return s }
  function snapshot(state: DemoState, s: Solution, note: string) { const list = state.versions[s.id] ||= []; list.unshift({ id: uid(), version: s.version, status: s.status, createdAt: now(), actorName: userName, note, snapshot: clone(s) }) }
  function changed(s: Solution) { s.revision++; s.updatedAt = now(); s.canEdit = s.status === 'draft' }
  function verify(s: Solution, revision: number) { if (s.revision !== revision) throw Object.assign(new Error('报告已在其他页面更新，请先重新载入并比较当前草稿。'), { status: 409 }) }
  function newSolution(input: SolutionInput): Solution { return { ...clone(input), id: uid(), ownerId: userId, ownerName: userName, status: 'draft', revision: 1, version: 1, updatedAt: now(), reviewerId: null, reviewerName: '', reviewNotes: '', canEdit: true } }
  function collaboration(state: DemoState, id: string): ReportCollaboration {
    const s = get(state, id)
    const current = (state.collaboration ||= {})[id] ||= { revision: s.revision, canManage: true, members: [{ id: userId, name: userName, role: 'owner' }], comments: [], presence: [] }
    current.revision = s.revision
    return current
  }
  const client: SolutionClient = {
    collaboration: async id => clone(collaboration(read(), id)),
    saveMember: async () => { throw new Error('本地预览仅演示当前账号；请在真实登录模式中添加组织协作者。') },
    comment: async (id, input) => { const state = read(), s = get(state, id), current = collaboration(state, id); if (!s.sections.some(section => section.id === input.sectionId)) throw new Error('章节不存在'); if (input.parentId && !current.comments.some(c => c.id === input.parentId && !c.parentId && c.sectionId === input.sectionId)) throw new Error('批注线程不存在'); current.comments.push({ ...input, id: uid(), actorId: userId, actorName: userName, parentId: input.parentId || null, resolved: false, revision: 1, createdAt: now() }); write(state) },
    resolveComment: async (id, commentId, revision, resolved) => { const state = read(), current = collaboration(state, id), comment = current.comments.find(c => c.id === commentId); if (!comment || comment.revision !== revision) throw new Error('批注已更新，请刷新'); comment.resolved = resolved; comment.revision++; write(state) },
    presence: async (id, sectionId) => { const state = read(), current = collaboration(state, id); current.presence = [{ actorId: userId, actorName: userName, sectionId, seenAt: now() }]; write(state); return clone(current) },
    noteLinks: async id => clone(read().noteLinks?.[id] || []),
    linkNote: async (id, noteId, sectionId) => { const state = read(); get(state, id); const note = await createPreviewNotesClient(`${namespace}:${userId}`, storage).get!(noteId), link = { id: `${sectionId}:${noteId}`, noteId, sectionId, noteTitle: note.title, noteRevision: note.revision, content: note.content }; const links = (state.noteLinks ||= {})[id] ||= []; state.noteLinks[id] = [...links.filter(v => v.id !== link.id), link]; write(state); return clone(link) },
    snapshot: async (id, revision, name) => { const state = read(), s = get(state, id); verify(s, revision); changed(s); snapshot(state, s, name); write(state); return clone(state.versions[id][0]) },
    restoreSection: async (id, versionId, revision, sectionId) => { const state = read(), s = get(state, id); verify(s, revision); const version = state.versions[id]?.find(v => v.id === versionId), section = version?.snapshot.sections.find(v => v.id === sectionId); if (!section) throw new Error('历史章节不存在'); snapshot(state, s, '恢复章节前'); const restored = { ...clone(section), parentId: s.sections.some(v => v.id === section.parentId) ? section.parentId : null }; s.sections = s.sections.some(v => v.id === sectionId) ? s.sections.map(v => v.id === sectionId ? restored : v) : [...s.sections, restored]; s.references = [...s.references.filter(r => r.sectionId !== sectionId), ...clone(version!.snapshot.references.filter(r => r.sectionId === sectionId))]; changed(s); write(state); return clone(s) },
    templates: async () => clone(read().templates || []),
    createTemplate: async (name, sections) => { const state = read(), value = { id: uid(), name, sections: clone(sections), createdAt: now() }; (state.templates ||= []).push(value); write(state); return clone(value) },
    deleteTemplate: async id => { const state = read(); state.templates = (state.templates || []).filter(t => t.id !== id); write(state) },
    topics: async id => clone(read().topics?.[id] || []),
    saveTopic: async (id, topic) => { const state = read(); get(state,id); const list = (state.topics ||= {})[id] ||= []; const current = list.find(t => t.id === topic.id); if ((current?.revision || 0) !== topic.revision) throw new Error('主题已更新，请重新打开报告'); const saved = { ...topic, revision: topic.revision + 1 }; state.topics[id] = [...list.filter(t => t.id !== topic.id), saved]; write(state); return clone(saved) },
    deleteTopic: async (id, topicId, revision) => { const state = read(); get(state,id); const current = state.topics?.[id]?.find(t => t.id === topicId); if ((current?.revision || 0) !== revision) throw new Error('主题已更新'); state.answers[id] = (state.answers[id] || []).filter(a => (a.conversationId || a.id) !== topicId); if(state.topics) state.topics[id] = (state.topics[id] || []).filter(t => t.id !== topicId); write(state) },
    capabilities: async () => clone(previewCapabilities),
    list: async () => clone(read().solutions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    trash: async () => clone((read().trash || []).map(({ solution, deletedAt }) => ({ id: solution.id, title: solution.title, revision: solution.revision, deletedAt }))),
    remove: async (id, revision) => { const state = read(), s = get(state, id); if (s.ownerId !== userId) throw new Error('只有报告作者可删除'); verify(s, revision); s.revision++; (state.trash ||= []).unshift({ solution: s, deletedAt: now() }); state.solutions = state.solutions.filter(item => item.id !== id); write(state) },
    restore: async (id, revision) => { const state = read(), item = (state.trash || []).find(entry => entry.solution.id === id); if (!item || item.solution.ownerId !== userId) throw new Error('报告不存在或无权访问'); verify(item.solution, revision); item.solution.revision++; item.solution.updatedAt = now(); state.solutions.unshift(item.solution); state.trash = (state.trash || []).filter(entry => entry.solution.id !== id); write(state); return clone(item.solution) },
    create: async input => { const state = read(), s = newSolution(input); state.solutions.unshift(s); write(state); return clone(s) },
    get: async id => clone(get(read(), id)),
    save: async (id, input) => { const state = read(), s = get(state, id); verify(s, input.revision); if (s.status !== 'draft') throw new Error('仅草稿可以编辑'); if (!state.versions[id]?.length || Date.now() - Date.parse(state.versions[id][0].createdAt) > 300000) snapshot(state,s,'自动保存快照'); Object.assign(s, clone(input)); changed(s); write(state); return clone(s) },
    review: async (id, action) => {
      const state = read(), s = get(state, id); verify(s, action.revision)
      const allowed: Record<string, string[]> = { submit: ['draft'], withdraw: ['in_review'], approve: ['in_review'], return: ['in_review'], revise: ['final'], archive: ['draft', 'final'], restore: ['draft', 'final', 'archived'] }
      if (!allowed[action.action]?.includes(s.status)) throw new Error('当前状态不能进行此操作')
      if (action.action === 'restore') {
        const version = (state.versions[id] || []).find(v => v.id === action.versionId)
        if (!version) throw new Error('版本不存在')
        snapshot(state, s, '恢复前版本'); const { title, productName, projectName, sections, formula, references } = clone(version.snapshot)
        Object.assign(s, { title, productName, projectName, sections, formula, references }); s.version++; s.status = 'draft'
      } else if (action.action === 'submit') { s.status = 'in_review'; s.reviewerId = userId; s.reviewerName = `${userName}（作者确认）` }
      else if (action.action === 'approve') s.status = 'final'
      else if (action.action === 'withdraw' || action.action === 'return') s.status = 'draft'
      else if (action.action === 'revise') { s.version++; s.status = 'draft' }
      else s.status = 'archived'
      s.reviewNotes = action.note; changed(s); snapshot(state, s, action.note || action.action); write(state); return clone(s)
    },
    reviewers: async () => [{ id: userId, name: userName }],
    versions: async id => clone(read().versions[id] || []),
    sources: async (query = '', projectName = '') => clone(read().sources.filter(s => (!projectName || s.projectName === projectName) && (!query.trim() || `${s.title} ${s.content} ${s.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())))),
    getSource: async id => {
      if (id.startsWith('kb:')) {
        const path = id.slice(3), base = libraryEmbedUrl(true)
        if (!base || !validLibraryPath(path)) throw new Error('请选择本地预览知识库中的资料')
        const url = new URL('/__library-preview/source', base); url.searchParams.set('path', path)
        const response = await fetch(url, { signal: AbortSignal.timeout(10000), credentials: 'omit' })
        if (!response.ok) throw Object.assign(new Error('预览资料已删除或暂不可读，请刷新知识库后重试'), { status: response.status })
        const source = await response.json() as KnowledgeSource
        if (source.id !== id || source.kind !== 'paper' || !Array.isArray(source.tags) || !source.tags.every(tag => typeof tag === 'string') || !['content', 'title', 'authors', 'date', 'projectName', 'locator', 'version', 'updatedAt', 'url'].every(key => typeof source[key as keyof KnowledgeSource] === 'string') || source.content.length > 500000) throw new Error('预览资料格式无效')
        const state = read(); state.sources = [source, ...state.sources.filter(item => item.id !== id)]; write(state)
        return clone(source)
      }
      const source = read().sources.find(item => item.id === id); if (!source) throw new Error('资料不存在'); return clone(source)
    },
    knowledgeStatus: async () => ({ configured: false, available: false, message: '界面预览 · 示例资料仅保存在当前浏览器，未连接企业知识库或 AI 模型。' }),
    addSource: async input => { const state = read(); if (!input.title.trim() || !input.content.trim()) throw new Error('请填写资料标题与正文'); const source = { ...clone(input), id: uid(), version: '1', updatedAt: now() }; state.sources.unshift(source); write(state); return clone(source) },
    ask: async (id, input) => {
      const provenance = input.answerMode ? previewProvenance(input.question, input.answerMode, true, !!input.sourceIds.length || !!input.projectName, (read().answers[id] || []).filter(answer => !input.conversationId || (answer.conversationId || answer.id) === input.conversationId).at(-1)?.answerMode) : undefined
      if (provenance && provenance.answerMode !== 'knowledge') {
        const state = read(); get(state, id)
        if (!input.question.trim()) throw new Error('请输入问题')
        const web = provenance.webReferences || []
        const references = web.map(source => {
          const sourceId = `web:${uid()}`
          state.sources.unshift({ id: sourceId, title: source.title, kind: 'web', authors: '', date: '', projectName: '', tags: ['界面演示'], content: source.excerpt, locator: source.url, version: '1', url: source.url, updatedAt: source.retrievedAt })
          return { id: uid(), sourceId, title: source.title, excerpt: source.excerpt, locator: source.url, sourceVersion: '1', sectionId: input.sectionId }
        })
        const answer: Answer = { id: uid(), conversationId: input.conversationId || uid(), question: input.question, context: input.context, scope: provenance.answerMode === 'web' ? '公开网络 · 界面演示' : '通用问答 · 不联网', createdAt: now(), mode: 'ai', references, ...provenance, content: provenance.answerMode === 'web' ? previewWebAnswer(input.question) : `> 界面演示 · 未实际联网\n\n这是一个通用问题，无需先从知识库选择资料。正式使用时，模型会直接解释概念、比较差异或整理思路。\n\n本轮问题：${input.question}\n\n当前仅展示自动选择通用回答的流程，没有调用模型生成实际答案。` }
        ;(state.answers[id] ||= []).push(answer); write(state); return clone(answer)
      }
      // Local fixture sources are refreshed as well, so removed documents cannot be cited from a stale cache.
      const externalIds = input.sourceIds.length ? input.sourceIds.filter(value => value.startsWith('kb:')) : read().sources.filter(source => source.id.startsWith('kb:') && (!input.projectName || source.projectName === input.projectName)).map(source => source.id)
      for (const sourceId of externalIds) {
        try { await client.getSource(sourceId) }
        catch (error) {
          if (input.sourceIds.length || (error as { status?: number }).status !== 404) throw error
          const state = read(); state.sources = state.sources.filter(source => source.id !== sourceId); write(state)
        }
      }
      const state = read(); get(state, id)
      if (!input.question.trim()) throw new Error('请输入问题')
      const topicQuestions = input.conversationId ? (state.answers[id] || []).filter(answer => (answer.conversationId || answer.id) === input.conversationId).slice(-6).map(answer => answer.question.slice(0, 500)).join(' ').slice(-1500) : ''
      const chars = `${input.question} ${input.context} ${topicQuestions}`.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      const terms = Array.from(new Set(Array.from({ length: Math.max(0, chars.length - 1) }, (_, i) => chars.slice(i, i + 2))))
      const candidates = state.sources.filter(s => (!input.sourceIds.length || input.sourceIds.includes(s.id)) && (!input.projectName || s.projectName === input.projectName))
      const ranked = candidates.map(source => ({ source, score: terms.reduce((n, term) => n + (`${source.title} ${source.content}`.toLowerCase().includes(term) ? 1 : 0), 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4)
      const references = ranked.map(({ source }) => ({ id: uid(), sourceId: source.id, title: source.title, excerpt: source.content.slice(0, 800), locator: source.locator, sourceVersion: source.version, sectionId: input.sectionId }))
      const answer: Answer = { id: uid(), conversationId: input.conversationId || uid(), question: input.question, context: input.context, scope: input.sourceIds.length ? `选定 ${input.sourceIds.length} 份资料` : input.projectName || '全部演示资料', createdAt: now(), mode: 'retrieval', references, content: references.length ? `找到 ${references.length} 份相关演示资料。以下是原文摘录，请核对条件后再采纳。\n\n${references.map((ref, i) => `[${i + 1}] ${ref.title}\n${ref.excerpt}`).join('\n\n')}\n\n待验证事项：这些为交互演示资料，未形成真实配方结论。` : '当前检索范围内未找到相关知识。可调整关键词、扩大所选资料范围或添加实践记录。' }
      if (provenance) Object.assign(answer, provenance)
      ;(state.answers[id] ||= []).push(answer); write(state); return clone(answer)
    },
    polish: async (id, input) => {
      const report = get(read(), id)
      if (!report.canEdit || report.status !== 'draft') throw new Error('当前报告不可编辑')
      if (!report.sections.some(section => section.id === input.sectionId)) throw new Error('润色章节不存在')
      if (!input.text.trim() || input.text.length > 5000) throw new Error('请选择 1–5,000 字进行润色')
      // This local preview only demonstrates text cleanup, never a generated model response.
      const content = input.text.trim().replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/([\p{Script=Han}]),(?=[\p{Script=Han}])/gu, '$1，').replace(/([\p{Script=Han}]);(?=[\p{Script=Han}])/gu, '$1；')
      return { content, model: '本地文字整理演示', mode: 'preview' }
    },
    history: async id => clone(read().answers[id] || []),
    exportWord: async id => exportPreview(get(read(), id)),
    publish: async id => {
      const state = read(), s = get(state, id)
      if (s.status !== 'final') throw new Error('请先完成报告定稿')
      const sourceId = `solution:${id}:${s.version}`, existing = state.sources.find(item => item.id === sourceId)
      if (existing) return clone(existing)
      const source: KnowledgeSource = { id: sourceId, title: s.title, kind: 'solution', authors: userName, date: now().slice(0, 10), projectName: s.projectName, tags: ['报告', '定稿', '演示'], content: s.sections.map(section => `${section.title}\n${section.content}`).join('\n\n'), locator: `报告 v${s.version}`, version: String(s.version), url: '', updatedAt: now() }
      state.sources.unshift(source); write(state); return clone(source)
    },
  }
  return client
}
