// 模板树工具：统计 / 不可变更新 / Excel 导出（CSV-based）

import type { TemplateNode, TemplateVersion, Template } from '../types'

export interface TemplateStats {
  subProjects: number
  tasks: number
  milestones: number
  totalEffort: number
  totalDuration: number  // 简单求和（不考虑并行）
}

export function computeStats(node: TemplateNode | undefined): TemplateStats {
  const stats: TemplateStats = { subProjects: 0, tasks: 0, milestones: 0, totalEffort: 0, totalDuration: 0 }
  if (!node) return stats
  function visit(n: TemplateNode, depth: number) {
    if (depth === 1) stats.subProjects++
    if (depth === 2) {
      if (n.isMilestone) stats.milestones++
      else stats.tasks++
      stats.totalEffort += n.defaultEffort || 0
      stats.totalDuration += n.defaultDuration || 0
    }
    n.children?.forEach((c) => visit(c, depth + 1))
  }
  node.children?.forEach((c) => visit(c, 1))
  return stats
}

// 不可变更新：根据 nodeId 找到节点并应用变换
export function updateNode(
  root: TemplateNode,
  nodeId: string,
  updater: (n: TemplateNode) => TemplateNode | null  // 返回 null 表示删除
): TemplateNode {
  function walk(n: TemplateNode): TemplateNode {
    if (n.id === nodeId) {
      const result = updater(n)
      // 删除由 parent 处理
      return result || n
    }
    if (!n.children) return n
    const newChildren: TemplateNode[] = []
    for (const c of n.children) {
      if (c.id === nodeId) {
        const r = updater(c)
        if (r) newChildren.push(r)
        // 否则跳过（删除）
      } else {
        newChildren.push(walk(c))
      }
    }
    return { ...n, children: newChildren }
  }
  return walk(root)
}

// 找到节点
export function findNode(root: TemplateNode, nodeId: string): TemplateNode | undefined {
  if (root.id === nodeId) return root
  for (const c of root.children || []) {
    const r = findNode(c, nodeId)
    if (r) return r
  }
  return undefined
}

// 找到父节点
export function findParent(root: TemplateNode, nodeId: string): TemplateNode | undefined {
  if (!root.children) return undefined
  for (const c of root.children) {
    if (c.id === nodeId) return root
    if (c.children) {
      const r = findParent(c, nodeId)
      if (r) return r
    }
  }
  return undefined
}

// 排序变换
export function moveNode(root: TemplateNode, nodeId: string, dir: 'up' | 'down'): TemplateNode {
  function walk(n: TemplateNode): TemplateNode {
    if (!n.children) return n
    const idx = n.children.findIndex((c) => c.id === nodeId)
    if (idx >= 0) {
      const arr = [...n.children]
      const swap = dir === 'up' ? idx - 1 : idx + 1
      if (swap >= 0 && swap < arr.length) {
        ;[arr[idx], arr[swap]] = [arr[swap], arr[idx]]
      }
      return { ...n, children: arr }
    }
    return { ...n, children: n.children.map(walk) }
  }
  return walk(root)
}

// 添加子节点
export function addChild(root: TemplateNode, parentId: string, child: TemplateNode): TemplateNode {
  function walk(n: TemplateNode): TemplateNode {
    if (n.id === parentId) {
      return { ...n, children: [...(n.children || []), child] }
    }
    if (!n.children) return n
    return { ...n, children: n.children.map(walk) }
  }
  return walk(root)
}

// 简单 ID 生成
export function genId(prefix = 'n') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }

// 简单 task code 生成
export function genTaskCode(existing: Set<string>): string {
  for (let i = 1; i < 9999; i++) {
    const code = `T${String(i).padStart(3, '0')}`
    if (!existing.has(code)) return code
  }
  return 'T9999'
}

export function collectTaskCodes(root: TemplateNode): Set<string> {
  const set = new Set<string>()
  function visit(n: TemplateNode) {
    if (n.taskCode) set.add(n.taskCode)
    n.children?.forEach(visit)
  }
  visit(root)
  return set
}

// === 版本对比 diff ===
export interface NodeDiff {
  type: 'added' | 'removed' | 'modified' | 'unchanged'
  nodeId: string
  name: string
  module?: string
  taskCode?: string
  level: 1 | 2
  isMilestone?: boolean
  changes?: { field: string; from: TemplateNode[keyof TemplateNode]; to: TemplateNode[keyof TemplateNode] }[]
}

export function diffVersions(a: TemplateNode, b: TemplateNode): NodeDiff[] {
  const result: NodeDiff[] = []

  function flatten(root: TemplateNode): { node: TemplateNode; level: 1 | 2; key: string }[] {
    const arr: { node: TemplateNode; level: 1 | 2; key: string }[] = []
    root.children?.forEach((sub) => {
      arr.push({ node: sub, level: 1, key: `L1::${sub.name}` })
      sub.children?.forEach((task) => {
        const key = task.taskCode ? `L2::${sub.name}::${task.taskCode}` : `L2::${sub.name}::${task.name}`
        arr.push({ node: task, level: 2, key })
      })
    })
    return arr
  }

  const aFlat = new Map(flatten(a).map((x) => [x.key, x]))
  const bFlat = new Map(flatten(b).map((x) => [x.key, x]))

  // a 中的节点：modified / removed
  for (const [key, av] of aFlat) {
    const bv = bFlat.get(key)
    if (!bv) {
      result.push({
        type: 'removed',
        nodeId: av.node.id,
        name: av.node.name,
        module: av.node.module,
        taskCode: av.node.taskCode,
        level: av.level,
        isMilestone: av.node.isMilestone,
      })
    } else {
      const changes: { field: string; from: TemplateNode[keyof TemplateNode]; to: TemplateNode[keyof TemplateNode] }[] = []
      const fields: (keyof TemplateNode)[] = ['name', 'defaultDuration', 'defaultEffort', 'isMilestone', 'defaultRole', 'module']
      for (const f of fields) {
        if (JSON.stringify(av.node[f]) !== JSON.stringify(bv.node[f])) {
          changes.push({ field: f, from: av.node[f], to: bv.node[f] })
        }
      }
      result.push({
        type: changes.length > 0 ? 'modified' : 'unchanged',
        nodeId: bv.node.id,
        name: bv.node.name,
        module: bv.node.module,
        taskCode: bv.node.taskCode,
        level: bv.level,
        isMilestone: bv.node.isMilestone,
        changes: changes.length > 0 ? changes : undefined,
      })
    }
  }
  // b 中独有：added
  for (const [key, bv] of bFlat) {
    if (!aFlat.has(key)) {
      result.push({
        type: 'added',
        nodeId: bv.node.id,
        name: bv.node.name,
        module: bv.node.module,
        taskCode: bv.node.taskCode,
        level: bv.level,
        isMilestone: bv.node.isMilestone,
      })
    }
  }
  return result
}

// === Excel 导出（CSV blob）===
export function exportTemplateAsExcel(template: Template, version: TemplateVersion): Blob {
  const lines: string[] = []
  // 表头
  lines.push('# 任务清单')
  lines.push([
    '子项目名称', '任务编号', '任务名称', '所属阶段', '所属模块',
    '默认工期(天)', '默认工时(人天)', '默认负责角色', '前置任务编号', '依赖类型', '延迟天数', '是否里程碑', '排序', '备注',
  ].join(','))
  const root = version.structureJson
  let order = 1
  root.children?.forEach((sub) => {
    sub.children?.forEach((task) => {
      const preds = task.predecessors?.map((p) => p.taskCode).join(';') || ''
      const types = task.predecessors?.map((p) => p.type).join(';') || ''
      const lags = task.predecessors?.map((p) => p.lagDays).join(';') || ''
      lines.push([
        sub.name,
        task.taskCode || '',
        task.name,
        task.stage || '',
        task.module || '',
        task.defaultDuration ?? '',
        task.defaultEffort ?? '',
        task.defaultRole || '',
        preds,
        types,
        lags,
        task.isMilestone ? '是' : '否',
        order++,
        '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    })
  })

  lines.push('')
  lines.push('# 子项目清单')
  lines.push(['子项目名称', '所属阶段', '所属模块'].join(','))
  root.children?.forEach((sub) => {
    lines.push([sub.name, sub.stage || '', sub.module || ''].map((v) => `"${v}"`).join(','))
  })

  lines.push('')
  lines.push(`# 模板：${template.name} ${version.versionNumber} · 导出于 ${new Date().toISOString().slice(0, 10)}`)

  // 加 BOM 让 Excel 正确识别中文
  const csv = '﻿' + lines.join('\n')
  return new Blob([csv], { type: 'text/csv;charset=utf-8' })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
