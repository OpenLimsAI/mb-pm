import { generateFinanceAIAnalysis, getFinanceAIAnalyses, type AIAnalysis } from '../../api/ai'
import { AIAnalysisPanel } from '../ai/AIAnalysisPanel'

const financeTags = (a: AIAnalysis) => [
  `数据截至 ${a.source.asOf}`,
  `${a.source.projectCount ?? 0} 个项目`,
  `${a.source.budgetedProjectCount ?? 0} 个已设预算`,
  `${a.source.overBudgetCount ?? 0} 个超支`,
]

// 财务 →「AI 财务分析」（admin / cmc_lead）：全部项目的预算执行、任务成本偏差与数据缺口。
// 与项目分析是同一套体系：共用 AI 设置、默认提示词（设置 › AI 分析 › 财务分析提示词）与报告存档。
export function FinanceAIAnalysis() {
  return (
    <AIAnalysisPanel
      kind="finance"
      title="AI 财务分析"
      description="结合各项目的预算执行、已承诺金额、任务成本偏差与进度，生成组合层面的财务判断和建议。"
      subject="项目组合财务"
      focusPlaceholder="例如：哪些项目的花费节奏与进度不匹配？剩余预算能否支撑下季度计划？哪些任务超支最严重？"
      dataNotice="点击后将全部项目的预算、已花费、已承诺、任务成本与进度发送至已配置的模型服务。分析结果仅作参考，不会修改任何数据。"
      emptyHint="完成 AI 设置后，生成第一份财务分析报告。"
      staleNotice="预算、任务成本或分析日期已变化，这份报告基于旧快照。请重新分析获取最新结论。"
      tags={financeTags}
      load={getFinanceAIAnalyses}
      generate={generateFinanceAIAnalysis}
    />
  )
}
