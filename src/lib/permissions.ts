// 权限矩阵（URS 第 5.2 节 + 6.x 扩展）
import type { Role } from '../types'

export type PermKey =
  | 'project.create' | 'project.delete'
  | 'template.edit' | 'template.import' | 'template.export'
  | 'subproject.create' | 'task.create'
  | 'task.update' | 'task.update.own'
  | 'task.budget.edit'   // 任务预算（执行层只能录入实际花费）
  | 'finance.edit'       // 项目预算（总预算 / 已承诺 / 成本结构）
  | 'dashboard.manager' | 'workload.view' | 'workload.recommend'
  | 'dashboard.personal'
  | 'gantt.view' | 'gantt.view.own' | 'gantt.edit'
  | 'calendar.view' | 'calendar.edit'
  | 'system.config' | 'user.manage' | 'data.export'
  // QA/QC 扩展（分析任务跟踪场景）
  | 'deviation.review'  // 偏差审核（OOS/OOT/CAPA）
  | 'batch.release'     // 批次放行决策
  // AI（与后端 api/v1/ai.py 一致）
  | 'ai.config'         // AI 服务商 / 模型 / 密钥设置
  | 'ai.analyze'        // 项目 AI 分析（另受项目可见范围约束）
  | 'ai.finance'        // 财务 AI 分析（覆盖全部项目的组合财务）

const M: Record<PermKey, Role[]> = {
  'project.create':       ['admin', 'cmc_lead'],
  'project.delete':       ['admin', 'cmc_lead'],
  'template.edit':        ['admin', 'cmc_lead'],
  'template.import':      ['admin', 'cmc_lead'],
  'template.export':      ['admin', 'cmc_lead'],
  'subproject.create':    ['admin', 'cmc_lead', 'project_lead'],
  'task.create':          ['admin', 'cmc_lead', 'project_lead'],
  'task.update':          ['admin', 'cmc_lead', 'project_lead'],
  'task.update.own':      ['rd', 'production', 'qa_qc'],
  'task.budget.edit':     ['admin', 'cmc_lead', 'project_lead'],
  'finance.edit':         ['admin', 'cmc_lead'],
  'dashboard.manager':    ['admin', 'cmc_lead', 'project_lead'],
  'workload.view':        ['admin', 'cmc_lead', 'project_lead'],
  'workload.recommend':   ['admin', 'cmc_lead', 'project_lead'],
  'dashboard.personal':   ['admin', 'cmc_lead', 'project_lead', 'rd', 'production', 'qa_qc'],
  'gantt.view':           ['admin', 'cmc_lead', 'project_lead'],
  'gantt.view.own':       ['rd', 'production', 'qa_qc'],
  'gantt.edit':           ['admin', 'cmc_lead', 'project_lead'],
  'calendar.view':        ['admin', 'cmc_lead', 'project_lead', 'rd', 'production', 'qa_qc'],
  'calendar.edit':        ['admin', 'cmc_lead', 'project_lead', 'production'],
  'system.config':        ['admin'],
  'user.manage':          ['admin'],
  // 数据导出：QA 因审计/法规需要必须可导出
  'data.export':          ['admin', 'cmc_lead', 'project_lead', 'qa_qc'],
  // QA/QC 专属审核权
  'deviation.review':     ['admin', 'cmc_lead', 'qa_qc'],
  'batch.release':        ['admin', 'qa_qc'],
  'ai.config':            ['admin', 'cmc_lead'],
  'ai.analyze':           ['admin', 'cmc_lead', 'project_lead'],
  'ai.finance':           ['admin', 'cmc_lead'],
}

export const can = (role: Role | undefined, perm: PermKey): boolean => {
  if (!role) return false
  return M[perm].includes(role)
}

export const roleLabels: Record<Role, string> = {
  admin: '系统管理员',
  cmc_lead: 'CMC 负责人',
  project_lead: '项目负责人',
  rd: '工艺开发',
  production: '生产支持',
  qa_qc: 'QA/QC',
}
