import { describe, expect, it } from 'vitest'
import { previewProvenance } from './preview'

describe('explicitly local preview routing', () => {
  it('keeps private questions and selected materials out of the public web route', () => {
    expect(() => previewProvenance('公司内部资料的最新进展', 'auto', false)).toThrow('启用知识库')
    expect(previewProvenance('不要联网，只查知识库', 'auto', true).answerMode).toBe('knowledge')
    expect(previewProvenance('当前章节有哪些相关知识？', 'auto', true).answerMode).toBe('knowledge')
    expect(previewProvenance('现有资料中的结论有哪些差异？', 'auto', true).answerMode).toBe('knowledge')
    expect(previewProvenance('最新研究', 'web', true, true).answerMode).toBe('knowledge')
    expect(previewProvenance('不要联网，解释最新的技术概念', 'auto').answerMode).toBe('general')
    expect(previewProvenance('知识库是什么', 'general', false).answerMode).toBe('general')
  })

  it('continues a topic using its last actual mode without inventing search results', () => {
    const result = previewProvenance('再详细一点', 'auto', true, false, 'web')
    expect(result.answerMode).toBe('web')
    expect(result.webReferences?.every(source => source.title.includes('非真实检索结果') && source.publishedAt === null)).toBe(true)
  })

  it('obeys offline wording and keeps knowledge followups inside their original permission scope', () => {
    for (const question of ['无需联网，解释最新技术', '不需要联网，解释最新技术', '离线回答：最新技术是什么', "don't search, explain the latest idea"]) expect(previewProvenance(question).answerMode).toBe('general')
    expect(previewProvenance('这些论文最新进展呢', 'auto', true, false, 'knowledge').answerMode).toBe('knowledge')
    expect(() => previewProvenance('这些论文最新进展呢', 'auto', false, false, 'knowledge')).toThrow('启用知识库')
    expect(previewProvenance('这些论文最新进展呢', 'auto', true, false, 'web').answerMode).toBe('web')
    expect(previewProvenance('这些论文最新进展呢', 'auto', true, false, 'general').answerMode).toBe('web')
    for (const question of ['我们自己的实验最新进展', '未公开的数据有多少', 'our internal unpublished project news']) expect(() => previewProvenance(question, 'auto', false)).toThrow('启用知识库')
  })
})
