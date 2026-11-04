import { describe, expect, it } from 'vitest'
import { builtInTemplates, checkReport, outlineFromAnswer, reusableContent, searchReportSections, templateSections, terminologyTitle } from './reportExperience'
import type { Answer, Solution } from './types'
const doc = { id: 'r1', title: '研究', sections: [], references: [] } as unknown as Solution
describe('report writing assistance', () => {
  it('checks missing content, unfinished tasks and unsupported claims without rewriting content', () => {
    const value = { ...doc, sections: [{ id: 'a', title: '目的', content: '' }, { id: 'b', title: '结果', content: '研究表明此方法优于对照。\n\n- [ ] 待补充数据' }] }
    const before = JSON.stringify(value), issues = checkReport(value)
    expect(issues.map(issue => issue.kind)).toEqual(['missing', 'placeholder', 'citation'])
    expect(JSON.stringify(value)).toBe(before)
  })
  it('locates duplicated paragraphs and inconsistent units for named measurements', () => {
    const paragraph = '这是一段比较完整的实验方法说明，记录研究对象、实验条件、比较方法及适用范围，并且需要避免在多个章节反复重复。'
    const value = { ...doc, sections: [{ id: 'a', title: '条件', content: paragraph + '\n\n浓度：10 mg/mL' }, { id: 'b', title: '结论', content: paragraph + '\n\n浓度：10 g/L' }] }
    expect(checkReport(value).map(issue => [issue.sectionId, issue.kind])).toEqual([['b', 'duplicate'], ['b', 'consistency']])
  })
  it('searches across readable reports, excludes the current report and preserves citations and source link', () => {
    const ref = { id: 'ref1', sectionId: 's1' }
    const other = { ...doc, id: 'r2', title: '稳定性验证', version: 2, sections: [{ id: 's1', title: '实验方法', content: '温度稳定性观察' }], references: [ref] } as Solution
    const matches = searchReportSections([doc, other], '稳定性 观察', doc.id)
    expect(matches).toHaveLength(1)
    expect(matches[0].references).toEqual([ref])
    expect(reusableContent(matches[0])).toContain('/solutions?report=r2')
    expect(searchReportSections([other], '', doc.id)).toEqual([])
  })
  it('creates independent template sections with requirements and checklists', () => {
    let count = 0
    const sections = templateSections(builtInTemplates[0], () => String(++count))
    expect(sections.map(section => section.id)).toEqual(['1', '2', '3', '4'])
    expect(sections[0].content).toContain('写作要求：')
    expect(sections[0].content).toContain('- [ ]')
  })
  it('flags named measurement value differences and applies report terminology rules outside their definition', () => {
    const value = { ...doc, sections: [{ id: 'terms', title: terminologyTitle, content: '检测方法=检测法' }, { id: 'a', title: '实验条件', content: '检测法A。\n浓度：10 mg/mL' }, { id: 'b', title: '结果', content: '浓度：20 mg/mL' }] }
    const issues = checkReport(value)
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ sectionId: 'a', message: expect.stringContaining('建议使用“检测方法”') }), expect.objectContaining({ sectionId: 'b', message: expect.stringContaining('10 mg/mL 和 20 mg/mL') })]))
    expect(issues.some(issue => issue.sectionId === 'terms')).toBe(false)
  })
  it('extracts a bounded unique outline and ignores prose or excessively long headings', () => {
    const answer = { content: '# 研究目标\n解释文字\n2. 证据比较\n## 研究目标\n# ' + '字'.repeat(121) } as Answer
    expect(outlineFromAnswer(answer)).toEqual(['研究目标', '证据比较'])
  })
  it('does not treat an unrelated hyperlink as evidence and reports dangling citations', () => {
    const value = { ...doc, sections: [{ id: 's', title: '结论', content: '研究表明方法有效。[帮助](https://example.org/help)\n\n[[cite:missing]]' }] }
    expect(checkReport(value).filter(issue => issue.kind === 'citation')).toHaveLength(2)
  })

})
