// 子项目内任务的显示顺序 —— 与后端 models/task.py 的 TASK_WBS_ORDER 一致：
// 有顺序号（手动顺序）的在前、按顺序号；没有顺序号的（升级前老数据 / 离线演示数据）在后，按计划开始、编号。
import type { Task } from '../types'

type Orderable = Pick<Task, 'plannedStart' | 'code'> & { sortOrder?: number | null }

export function byWbsOrder(a: Orderable, b: Orderable): number {
  const x = a.sortOrder ?? null
  const y = b.sortOrder ?? null
  if (x !== y) {
    if (x === null) return 1
    if (y === null) return -1
    return x - y
  }
  return a.plannedStart.localeCompare(b.plannedStart) || a.code.localeCompare(b.code)
}
