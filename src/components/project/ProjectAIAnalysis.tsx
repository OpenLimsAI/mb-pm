import { useCallback } from 'react'
import { generateAIAnalysis, getAIAnalyses, type AIAnalysis } from '../../api/ai'
import { AIAnalysisPanel } from '../ai/AIAnalysisPanel'

const projectTags = (a: AIAnalysis) => [
  `数据截至 ${a.source.asOf}`,
  `${a.source.taskCount ?? 0} 项任务`,
  `${a.source.milestoneCount ?? 0} 个里程碑`,
  `${a.source.overdueCount ?? 0} 项逾期`,
]

// 项目详情 →「AI 分析」：单个项目的进度、里程碑、依赖、团队、预算与基线。
export function ProjectAIAnalysis({ projectId, projectName }: { projectId: string; projectName: string }) {
  const load = useCallback(() => getAIAnalyses(projectId), [projectId])
  const generate = useCallback((focus: string, prompt: string) => generateAIAnalysis(projectId, focus, prompt), [projectId])
  return (
    <AIAnalysisPanel
      kind="project"
      title="项目 AI 分析"
      description="结合进度、里程碑、依赖、团队、预算与最新基线，生成有依据的管理建议。"
      subject={projectName}
      focusPlaceholder="例如：哪些里程碑可能延期？下两周应优先解决哪些阻塞？预算是否支持当前计划？"
      dataNotice="点击后将项目资料发送至已配置的模型服务。分析结果仅作为管理参考，不会自动修改项目数据。"
      emptyHint="完成 AI 设置后，生成第一份项目分析报告。"
      staleNotice="项目数据或分析日期已变化，这份报告基于旧快照。请重新分析获取最新结论。"
      tags={projectTags}
      load={load}
      generate={generate}
    />
  )
}
