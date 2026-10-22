// 子项目内任务的显示顺序 —— 与后端 models/task.py 的 TASK_WBS_ORDER 一致：
// 有顺序号（手动顺序）的在前、按顺序号；没有顺序号的（升级前老数据 / 离线演示数据）在后，按计划开始、编号。
import type { Project, SubProject, Task } from '../types'

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

/** 全局任务与项目视角对齐：项目列表顺序 → 子项目手动顺序 → 子项目内 WBS 顺序。
 * 只对已通过权限筛选的任务排序，不修改输入数组或任务的持久化顺序号。 */
export function sortTasksByProjectWbsOrder<T extends Orderable & Pick<Task, 'subProjectId'>>(
  tasks: readonly T[],
  projects: readonly Pick<Project, 'id'>[],
  subProjects: readonly Pick<SubProject, 'id' | 'projectId' | 'sortOrder'>[],
): T[] {
  const projectRanks = new Map(projects.map((p, i) => [p.id, i]))
  const subsById = new Map(subProjects.map((s) => [s.id, s]))
  // 与 WBSTree 相同：序号相同时保留原子项目列表中的先后。
  const subRanks = new Map([...subProjects].sort((a, b) => a.sortOrder - b.sortOrder).map((s, i) => [s.id, i]))
  const last = Number.MAX_SAFE_INTEGER
  return [...tasks].sort((a, b) => {
    const aSub = subsById.get(a.subProjectId)
    const bSub = subsById.get(b.subProjectId)
    const projectOrder = (projectRanks.get(aSub?.projectId ?? '') ?? last) - (projectRanks.get(bSub?.projectId ?? '') ?? last)
    if (projectOrder) return projectOrder
    const subOrder = (subRanks.get(a.subProjectId) ?? last) - (subRanks.get(b.subProjectId) ?? last)
    return subOrder || byWbsOrder(a, b)
  })
}
