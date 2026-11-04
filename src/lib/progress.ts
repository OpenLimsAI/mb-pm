import type { Task } from '../types'
import type { ProgressMethod } from '../api/progressPolicy'

/** Same defaults and rounding as backend services/rollup.py. */
export function progressWeight(task: Task, method: ProgressMethod = 'equal'): number {
  if (method === 'equal') return 1
  if (method === 'effort') return task.isMilestone ? 0 : Math.max(0, task.estimatedEffort || 0)
  return task.progressWeight ?? (task.isMilestone ? 0 : 1)
}
export function calculateProgress(tasks: Task[], method: ProgressMethod = 'equal'): number {
  // Fixed-point weights avoid floating-point drift at rounding boundaries.
  const units = tasks.map(task => BigInt(Math.round(progressWeight(task, method) * 10000)))
  const denominator = units.reduce((sum, weight) => sum + weight, 0n)
  const numerator = units.reduce((sum, weight, i) => sum + weight * BigInt(tasks[i].progress), 0n)
  return denominator ? Number((numerator * 2n + denominator) / (denominator * 2n)) : 0
}
