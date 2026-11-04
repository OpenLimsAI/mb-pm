import type { Answer, Reference, Section, Solution } from './types'

export interface WritingTemplate { id: string; name: string; sections: { title: string; instruction: string; checks: string[] }[] }
export const builtInTemplates: WritingTemplate[] = [
  { id: 'literature', name: '研究综述', sections: [
    { title: '研究问题与检索范围', instruction: '明确研究问题、检索范围及文献纳入标准。', checks: ['检索范围', '纳入标准'] },
    { title: '已有研究与证据比较', instruction: '比较研究对象、方法、结果和适用条件，逐项引用原始资料。', checks: ['研究条件', '来源引用'] },
    { title: '争议与证据缺口', instruction: '区分一致结论、相互矛盾的证据和仍需验证的假设。', checks: ['相反证据', '局限性'] },
    { title: '结论与后续研究', instruction: '根据证据回答研究问题，给出下一步验证安排。', checks: ['证据支持', '后续安排'] },
  ] },
  { id: 'experiment', name: '实验总结', sections: [
    { title: '实验目的与假设', instruction: '描述目标、假设以及用于判断的指标。', checks: ['目标指标', '实验假设'] },
    { title: '材料、方法与条件', instruction: '记录批次、方法、条件、对照及偏差。', checks: ['批次信息', '对照与条件'] },
    { title: '结果与分析', instruction: '插入数据表与图，记录单位、重复次数和分析方法。', checks: ['单位', '重复次数'] },
    { title: '结论、局限与下一步', instruction: '区分实验观察和解释，说明局限及下一步计划。', checks: ['观察与推断', '下一步计划'] },
  ] },
  { id: 'evaluation', name: '技术评估', sections: [
    { title: '评估目标与标准', instruction: '明确决策问题、评价维度和可接受标准。', checks: ['评价标准', '适用范围'] },
    { title: '候选方案与依据', instruction: '逐一说明候选方案及其来源，比较优势与限制。', checks: ['候选方案', '参考依据'] },
    { title: '比较、风险与验证', instruction: '使用统一指标比较方案，列出风险及待验证事项。', checks: ['统一指标', '验证安排'] },
    { title: '建议与实施条件', instruction: '说明建议的依据、成立条件以及实施计划。', checks: ['推荐依据', '成立条件'] },
  ] },
]
export function templateSections(template: WritingTemplate, id: () => string = () => crypto.randomUUID()): Section[] {
  return template.sections.map(section => ({ id: id(), title: section.title, content: `写作要求：${section.instruction}\n\n检查项：\n${section.checks.map(check => `- [ ] ${check}`).join('\n')}\n\n` }))
}
export interface ReportIssue { id: string; sectionId: string; kind: 'missing' | 'placeholder' | 'duplicate' | 'citation' | 'consistency'; message: string; excerpt: string }
export function checkReport(doc: Solution): ReportIssue[] {
  const issues: ReportIssue[] = [], seen = new Map<string, string>(), units = new Map<string, { unit: string; sectionId: string }>()
  const add = (section: Section, kind: ReportIssue['kind'], message: string, excerpt = '') => issues.push({ id: `${section.id}-${kind}-${issues.length}`, sectionId: section.id, kind, message, excerpt: excerpt.slice(0, 160) })
  for (const section of doc.sections) {
    if (!section.content.trim()) add(section, 'missing', '章节正文为空。')
    const markers = section.content.match(/TODO|待补充|待填写|待核实|\[\s*\]|XX(?:X+)?|待验证事项[：:]\s*$/gim)
    if (markers) add(section, 'placeholder', `还有 ${markers.length} 处占位内容或未完成检查项。`, markers.slice(0, 5).join('、'))
    for (const paragraph of section.content.split(/\n\s*\n/)) {
      const clean = paragraph.replace(/\s+/g, '').trim()
      if (clean.length < 40) continue
      const prior = seen.get(clean)
      if (prior) add(section, 'duplicate', `与“${prior}”中的一段内容重复。`, paragraph)
      else seen.set(clean, section.title)
    }
    const refs = doc.references.filter(ref => ref.sectionId === section.id)
    for (const match of section.content.matchAll(/\[\[cite:([^\]\n]+)\]\]/g)) {
      let id: string; try { id = decodeURIComponent(match[1]) } catch { id = '' }
      if (!doc.references.some(ref => ref.id === id)) add(section, 'citation', '正文引用未关联可用的参考依据，请重新选择来源。', match[0])
    }
    if (/研究表明|文献表明|证实|显著(?:提高|降低|改善)|优于|证明|结果显示/.test(section.content) && !refs.length) add(section, 'citation', '本章包含结论性表述，尚未关联参考依据。请核查来源。')
    for (const ref of refs) if (!ref.sourceVersion || !ref.locator) add(section, 'citation', `“${ref.title}”缺少${!ref.sourceVersion ? '来源版本' : '原文位置'}。`, ref.excerpt)
    for (const match of section.content.matchAll(/([\p{L}\p{N}]{2,12})[：:]\s*(\d+(?:\.\d+)?)\s*(mg\/mL|μg\/mL|ug\/mL|g\/L|mg|μg|ug|mL|ml|L|℃|°C|%)/gu)) {
      const key = match[1], unit = match[3].replace('ml', 'mL').replace('ug', 'μg').replace('°C', '℃'), prior = units.get(key)
      if (prior && prior.unit !== unit) add(section, 'consistency', `“${key}”在报告中使用了 ${prior.unit} 和 ${unit}，请核对单位及换算。`, match[0])
      else units.set(key, { unit, sectionId: section.id })
    }
  }
  return issues
}
export interface ReusableSection { reportId: string; reportTitle: string; version: number; section: Section; references: Reference[] }
export function searchReportSections(reports: Solution[], query: string, excludeId: string): ReusableSection[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return reports.filter(report => report.id !== excludeId).flatMap(report => report.sections.filter(section => terms.every(term => `${report.title}\n${section.title}\n${section.content}`.toLocaleLowerCase().includes(term))).map(section => ({ reportId: report.id, reportTitle: report.title, version: report.version, section, references: report.references.filter(ref => ref.sectionId === section.id) }))).slice(0, 40)
}
export function reusableContent(item: ReusableSection): string {
  return `${item.section.content}\n\n[来源：${item.reportTitle.replace(/[[\]]/g, '')} · ${item.section.title.replace(/[[\]]/g, '')} · v${item.version}](/solutions?report=${encodeURIComponent(item.reportId)})`
}
export function outlineFromAnswer(answer: Answer): string[] {
  const headings = answer.content.split('\n').map(line => line.trim()).filter(line => /^(?:#{1,4}\s+|\d+[.、)]\s*)/.test(line)).map(line => line.replace(/^(?:#{1,4}\s+|\d+[.、)]\s*)/, '').replace(/\*\*/g, '').trim()).filter(title => title.length > 0 && title.length <= 120)
  return [...new Set(headings)].slice(0, 20)
}
