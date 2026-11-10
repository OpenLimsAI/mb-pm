import { ProjectAIWorkbench } from './ProjectAIWorkbench'

// 项目详情 →「AI 分析」：单个项目的进度、里程碑、依赖、团队、预算与基线。
export function ProjectAIAnalysis(props: Parameters<typeof ProjectAIWorkbench>[0]) {
  return <ProjectAIWorkbench key={props.projectId} {...props} />
}
