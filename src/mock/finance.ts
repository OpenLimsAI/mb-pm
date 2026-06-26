// 财务 mock 数据 — Lite 版（基于 DMP 项目实例化）
//
// 3 个项目：P1 早期 / P2 中段 / P3 刚启动 — 反映各自的 spent / committed 状态。

export type FinanceCategory = '人力' | '设备' | '原材料' | '外部服务' | '其他'

export interface ProjectFinance {
  projectId: string
  totalBudget: number
  spent: number
  committed: number
  breakdown: Record<FinanceCategory, number>
  fiscalYear: string
  notes?: string
}

// 预算估算原则：DMP 模板 33 任务累计预算 ~1740 万；考虑到原液工艺开发只占
// 全 BLA 流程预算约 25%（其余有 CLD / FM / GMP / 申报 / QC 等域），
// 单个项目总预算落在 6800–7500 万。

export const projectFinances: ProjectFinance[] = [
  // P1 MAB-201 — 临床前阶段，USP 早期开发完成、即将进入 IND
  {
    projectId: 'p1',
    totalBudget: 7000,
    spent: 1480,
    committed: 280,
    breakdown: { '人力': 820, '设备': 460, '原材料': 280, '外部服务': 180, '其他': 20 },
    fiscalYear: '2025-2028',
    notes: 'USP 早期开发完成，即将进入 IND 阶段',
  },
  // P2 MAB-202 — IND 阶段进行中，DSP 中段
  {
    projectId: 'p2',
    totalBudget: 7500,
    spent: 3680,
    committed: 520,
    breakdown: { '人力': 1980, '设备': 1080, '原材料': 720, '外部服务': 380, '其他': 40 },
    fiscalYear: '2024-2027',
    notes: 'IND 阶段进行中，DSP 工艺开发处于中段',
  },
  // P3 MAB-203 — 刚启动，仅 USP 培养基筛选启动
  {
    projectId: 'p3',
    totalBudget: 6800,
    spent: 380,
    committed: 220,
    breakdown: { '人力': 380, '设备': 140, '原材料': 60, '外部服务': 20, '其他': 0 },
    fiscalYear: '2026-2028',
    notes: '项目初启动，USP 培养基筛选进行中',
  },
]

// ============= 派生计算 =============

export function getProjectFinance(projectId: string): ProjectFinance | undefined {
  return projectFinances.find((f) => f.projectId === projectId)
}

export function executionRate(f: ProjectFinance): number {
  if (f.totalBudget === 0) return 0
  return Math.round(((f.spent + f.committed) / f.totalBudget) * 100)
}

export function isOverBudget(f: ProjectFinance): boolean {
  return f.spent + f.committed > f.totalBudget
}

export interface FinanceSummary {
  totalBudget: number
  totalSpent: number
  totalCommitted: number
  remaining: number
  executionRate: number
  overBudgetCount: number
  byCategory: Record<FinanceCategory, number>
}

export function summarizeFinances(activeProjectIds: string[]): FinanceSummary {
  const finances = projectFinances.filter((f) => activeProjectIds.includes(f.projectId))
  const totalBudget = finances.reduce((s, f) => s + f.totalBudget, 0)
  const totalSpent = finances.reduce((s, f) => s + f.spent, 0)
  const totalCommitted = finances.reduce((s, f) => s + f.committed, 0)
  const overBudgetCount = finances.filter(isOverBudget).length
  const byCategory: Record<FinanceCategory, number> = {
    '人力': 0, '设备': 0, '原材料': 0, '外部服务': 0, '其他': 0,
  }
  for (const f of finances) {
    for (const k in byCategory) {
      const cat = k as FinanceCategory
      byCategory[cat] += f.breakdown[cat]
    }
  }
  return {
    totalBudget, totalSpent, totalCommitted,
    remaining: totalBudget - totalSpent - totalCommitted,
    executionRate: totalBudget > 0 ? Math.round(((totalSpent + totalCommitted) / totalBudget) * 100) : 0,
    overBudgetCount,
    byCategory,
  }
}
