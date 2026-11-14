import { ProjectAIWorkbench } from './ProjectAIWorkbench'

// 综合评估的兼容包装；项目详情通过项目 AI 助手提供此能力。
export function ProjectAIAnalysis(props: Parameters<typeof ProjectAIWorkbench>[0]) {
  return <ProjectAIWorkbench key={props.projectId} {...props} />
}
