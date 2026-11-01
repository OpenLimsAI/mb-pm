import type { ActualAnswerMode, AnswerCapabilities, AnswerMode, AnswerProvenance, WebReference } from './types'

export const previewCapabilities: AnswerCapabilities = { webSearch: { configured: false, provider: null, message: '联网搜索尚未配置，请联系管理员开通。' }, modes: ['auto', 'general', 'knowledge', 'web'] }
// This planner only controls the local, explicitly labelled interface demo.
// Production routing and permissions are decided by the server.
export function previewProvenance(question: string, requested: AnswerMode = 'auto', knowledgeAllowed = true, constrained = false, previousMode?: ActualAnswerMode): AnswerProvenance {
  let mode: ActualAnswerMode
  const noWeb = /(?:不(?:要|用|必|允许|需要)?|无需|无须|禁止|别)(?:再|进行|使用|调用|用)?(?:联网|上网|搜索|网络|检索互联网)|仅(?:用|凭|使用)已有知识|只(?:用|凭|使用)(?:已有|模型)知识|离线(?:回答|模式)|without (?:web|internet)|(?:do not|don't) (?:browse|search)/i.test(question)
  const privateIntent = /知识库|论文库|已上传|上传的|所选资料|这些材料|这份资料|当前章节|本章|现有资料|已有资料|资料中的|材料中的|附带资料|公司内部|内部(?:资料|文件|数据|实验|项目)|本公司|本次材料|未公开|保密(?:资料|数据|文件|项目|实验|信息)|我们(?:自己的|的)(?:实验|项目|数据|资料)|我方(?:实验|项目|数据|资料)|\b(?:our internal|our confidential|unpublished (?:data|experiment|project))\b/i.test(question)
  const followup = question.trim().length <= 80 && /^(继续|再说|再详细|展开|还有呢|然后呢|为什么|那[么这它]|这些|上述|上面|它们|what about|and |why\b)/i.test(question.trim())
  if (constrained) mode = 'knowledge'
  else if (requested === 'knowledge' || requested === 'general') mode = requested
  else if (noWeb) mode = privateIntent ? 'knowledge' : 'general'
  else if (privateIntent) mode = 'knowledge'
  else if (requested === 'web') mode = 'web'
  else if (followup && (previousMode === 'knowledge' || previousMode === 'web')) mode = previousMode
  else if (/最新|近期|最近|当前|目前|今天|今年|新闻|进展|联网|上网|搜索|检索|查找.{0,20}(?:论文|文献)|(?:论文|文献).{0,20}(?:查找|搜)|\b(?:latest|recent|current|today|news|search|202[6-9])\b/i.test(question)) mode = 'web'
  else mode = 'general'
  if (mode === 'knowledge' && !knowledgeAllowed) throw Object.assign(new Error('该问题涉及内部或知识库资料，请先在数据设置中启用知识库。'), { status: 422 })
  return { answerMode: mode, requestedMode: requested, modeReason: mode === 'web' ? requested === 'web' ? '按你的选择使用联网检索。以下仅演示展示方式。' : '问题需要外部或近期资料，自动选择联网检索。以下仅演示展示方式。' : mode === 'knowledge' ? '按指定的知识库范围查找依据；本轮引用数量不代表整个知识库的数量。' : '使用通用知识整理回答，无需联网搜索。', webReferences: mode === 'web' ? demoWebReferences() : [] }
}
export function demoWebReferences(): WebReference[] {
  return [1, 2].map((number) => ({ id: `demo-web-${number}`, title: `示例来源 ${number} · 非真实检索结果`, url: `https://example.com/#demo-source-${number}`, publishedAt: null, retrievedAt: new Date().toISOString(), excerpt: '此处演示原文摘要、出处链接和日期的呈现方式。未检索论文，也不提供实际研究结论。' }))
}
export function previewWebAnswer(question: string) {
  return `> 界面演示 · 未实际联网\n\n你问的是：“${question.slice(0, 500)}”\n\n自动模式判断这个问题需要查找外部资料。正式启用后，助手会搜索、阅读相关来源，再按主题整理回答并附上引用。\n\n## 回答会如何呈现\n\n- **主要发现**：按来源归纳，并用 [1]、[2] 标注依据。\n- **时间与适用范围**：注明发表日期；来源没有日期时明确说明。\n- **不确定性**：指出资料缺口及结论限制。\n\n下方是来源卡片的界面示例 [1][2]，不代表真实论文或最新研究结果。管理员配置搜索服务后，才会出现真实检索内容。`
}
