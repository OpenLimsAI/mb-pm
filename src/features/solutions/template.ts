import type { SolutionInput } from './types'

export const sectionTitles = ['研究目标与适用范围', '已有知识与实践基础', '候选配方与选择依据', '工艺思路与关键条件', '验证安排与评价方法', '风险与待解决问题', '专家结论与参考资料']
export function emptySolution(title = '未命名配方研究报告'): SolutionInput {
  return { title, projectName: '', productName: '', sections: sectionTitles.map((name, index) => ({ id: `section-${index + 1}`, title: name, content: '' })), formula: [], references: [] }
}
export const sourceKinds = { paper: '论文', practice: '实践记录', note: '专家笔记', solution: '历史报告', web: '网络来源' } as const
export const statusLabels = { draft: '草稿', in_review: '待评审', final: '已定稿', archived: '已归档' } as const
