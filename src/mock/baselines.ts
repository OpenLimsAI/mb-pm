// 计划基线运行时数组 —— 由 bootstrap 从后端填充（离线 mock 初始为空）。
import type { ProjectBaseline } from '../types'

export const projectBaselines: ProjectBaseline[] = []

export const getProjectBaselines = (projectId: string): ProjectBaseline[] =>
  projectBaselines.filter((b) => b.projectId === projectId)
