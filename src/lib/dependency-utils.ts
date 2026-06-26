// 依赖关系工具：前驱集合 diff + 成环检测。
// 用于「里程碑设置」保存前的校验与数据层编排（增删 FS 依赖）。

import type { TaskDependency } from '../types'

export interface PredecessorDiff {
  /** 需要新建依赖的前驱任务 id（predecessorId）。 */
  addedIds: string[]
  /** 需要删除的依赖记录 id（TaskDependency.id）。 */
  removedDepIds: string[]
}

/**
 * 比较某后继任务（里程碑）当前前驱依赖与目标前驱集合，得出最小增删。
 * @param current  当前以该任务为 successor 的依赖记录
 * @param nextPredIds  目标前驱任务 id 集合
 */
export function diffPredecessors(
  current: TaskDependency[],
  nextPredIds: string[],
): PredecessorDiff {
  const currentPredIds = new Set(current.map((d) => d.predecessorId))
  const nextSet = new Set(nextPredIds)

  const addedIds = nextPredIds.filter((id) => !currentPredIds.has(id))
  const removedDepIds = current
    .filter((d) => !nextSet.has(d.predecessorId))
    .map((d) => d.id)

  return { addedIds, removedDepIds }
}

/**
 * 在「现有依赖 + 拟新增边」构成的有向图中检测是否成环。
 * 边方向：predecessor → successor（前驱指向后继）。
 * @returns true 表示会形成环（应阻止保存）。
 */
export function detectCycle(
  existing: TaskDependency[],
  addEdges: { predecessorId: string; successorId: string }[],
): boolean {
  // 构建邻接表
  const adj = new Map<string, string[]>()
  const addEdge = (from: string, to: string) => {
    if (!adj.has(from)) adj.set(from, [])
    adj.get(from)!.push(to)
  }
  for (const d of existing) addEdge(d.predecessorId, d.successorId)
  for (const e of addEdges) addEdge(e.predecessorId, e.successorId)

  // 自环（A→A）直接判环
  for (const e of addEdges) if (e.predecessorId === e.successorId) return true

  // DFS 三色法检测有向图环
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()

  const hasCycleFrom = (node: string): boolean => {
    color.set(node, GRAY)
    for (const next of adj.get(node) || []) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) return true // 回到正在访问的节点 → 环
      if (c === WHITE && hasCycleFrom(next)) return true
    }
    color.set(node, BLACK)
    return false
  }

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      if (hasCycleFrom(node)) return true
    }
  }
  return false
}
