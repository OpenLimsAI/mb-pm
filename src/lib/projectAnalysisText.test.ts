import { describe, expect, it } from 'vitest'
import { projectAnalysisText } from './projectAnalysisText'

describe('项目分析可读正文', () => {
  it('移除完整与截断的行动块，保留前后分析及普通代码', () => {
    expect(projectAnalysisText('分析依据\n```pm-actions\n[{"title":"机器建议"}]\n```\n\n后续说明')).toBe('分析依据\n\n后续说明')
    expect(projectAnalysisText('分析依据\n```pm-actions\n[{"title":"未闭合建议')).toBe('分析依据')
    expect(projectAnalysisText('分析依据\n~~~PM-ACTIONS\n[]\n~~~\n后续说明')).toBe('分析依据\n后续说明')
    expect(projectAnalysisText('```json\n{"example":true}\n```\n正文')).toBe('```json\n{"example":true}\n```\n正文')
    expect(projectAnalysisText('````text\n```pm-actions\n只是围栏示例\n```\n````')).toBe('````text\n```pm-actions\n只是围栏示例\n```\n````')
  })
})
