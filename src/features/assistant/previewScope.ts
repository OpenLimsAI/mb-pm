import { previewProvenance } from '../answerModes/preview'
import type { ActualAnswerMode, AnswerMode, AnswerProvenance } from '../answerModes/types'
import { normalizeDataSources } from './dataSources'
import type { ApplicationDataSource } from './dataSources'

interface PreviousAnswer { answerMode?: ActualAnswerMode; usedSources?: readonly ApplicationDataSource[] }
export interface PersonalProvenance extends AnswerProvenance { usedSources: ApplicationDataSource[] }
const explicitProjectSystem = /项目管理(?:应用|系统|数据)/
const projectDirectory = /(?:当前|目前|现有|现在|所有|全部|有哪些|有多少|几个|列出|罗列|查看|查询|统计).{0,10}项目/
const projectDetails = /项目.{0,12}(?:清单|列表|目录|数量|有哪些|有多少|几个|状态|负责人|进度|起止|开始时间|结束时间|截止|延期|完成情况|概况|最新进展)|(?:我们|我方|本公司|我的|我负责|我参与).{0,6}项目/
const knowledgeQuestion = /知识库|论文库/
const knowledgeArticle = /文章|论文|文献|指南|概念|定义|方法|专题/
const jointRequest = /结合|综合|对照|关联|同时|联动/
const knowledgeScopePrefix = /^(?:请|帮我|请帮我)?(?:查询|检索|搜索|整理|总结|列出|介绍)?(?:一下)?(?:知识库|论文库)(?:中|里|内|的)/
const providedMaterial = /(?:本轮|本次|附带的?|这份|这些|已上传的?|上传的|提供的)(?:资料|材料|文件|文档|内容|正文|摘录)|附件/
const followupQuestion = /^(继续|再说|再详细|展开|还有呢|然后呢|为什么|那[么这它]|这些|上述|上面|它们|what about|and |why\b)/i

export function previewPersonalProvenance(question: string, requested: AnswerMode, sources: readonly ApplicationDataSource[], previous?: PreviousAnswer, referenceMaterialAvailable = false): PersonalProvenance {
  const text = question.trim()
  const knowledgeAllowed = sources.includes('knowledge')
  // Explicit general/knowledge restrictions keep the shared planner's priority.
  if (requested === 'general' || requested === 'knowledge') {
    const result = previewProvenance(question, requested, knowledgeAllowed, false, previous?.answerMode, referenceMaterialAvailable)
    return { ...result, usedSources: result.answerMode === 'knowledge' ? ['knowledge'] : [] }
  }
  if (referenceMaterialAvailable && !explicitProjectSystem.test(text) && providedMaterial.test(text) && !/知识库|论文库|公司内部|内部系统|未公开|保密资料/.test(text)) {
    const provided = previewProvenance(question, requested, knowledgeAllowed, false, undefined, true)
    if (provided.answerMode === 'general') return { ...provided, usedSources: [] }
  }
  const continuingProject = question.trim().length <= 80 && followupQuestion.test(question.trim()) && previous?.answerMode === 'application' && previous.usedSources?.includes('projects')
  const articleOnly = knowledgeQuestion.test(text) && knowledgeArticle.test(text) && !jointRequest.test(text) && !explicitProjectSystem.test(text) && (knowledgeScopePrefix.test(text) || !projectDirectory.test(text))
  const projectIntent = (explicitProjectSystem.test(text) || projectDirectory.test(text) || projectDetails.test(text)) && !articleOnly
  if (projectIntent || continuingProject) {
    const usedSources: ApplicationDataSource[] = ['projects']
    if (knowledgeQuestion.test(text) || continuingProject && previous?.usedSources?.includes('knowledge')) usedSources.push('knowledge')
    if (!sources.includes('projects')) throw Object.assign(new Error('该问题涉及项目管理数据，请先在数据设置中启用项目管理。'), { status: 422 })
    if (usedSources.includes('knowledge') && !knowledgeAllowed) throw Object.assign(new Error('本次需要项目管理和知识库数据，请先在数据设置中启用知识库。'), { status: 422 })
    return { answerMode: 'application', requestedMode: requested, usedSources, webReferences: [], modeReason: `${continuingProject ? '延续上一轮范围，' : ''}按问题需要只读查询${usedSources.includes('knowledge') ? '项目管理和知识库' : '项目管理'}；以下仅为界面演示。` }
  }
  const base = previewProvenance(question, requested, knowledgeAllowed, false, previous?.answerMode, referenceMaterialAvailable)
  return { ...base, usedSources: base.answerMode === 'knowledge' ? ['knowledge'] : [] }
}

export function previewApplicationAnswer(question: string, sources: readonly ApplicationDataSource[]) {
  const included = normalizeDataSources(sources).map(source => source === 'projects' ? '项目管理' : '知识库').join('和')
  return `> 界面演示 · 未读取真实项目数据\n\n本轮问题：“${question.slice(0, 500)}”\n\n本轮判断需要只读查询${included}。本地预览没有访问真实项目或知识库，不展示虚构的项目列表或进度。\n\n正式使用时，将仅在当前账号权限内查询项目名称、状态、负责人、进度和起止时间，并说明本轮返回数量及是否还有未展示的项目。勾选的数据源仅代表允许使用，不会让每个普通问题都读取应用数据。`
}
