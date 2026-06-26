// 生产支持模块 mock 数据 — Lite 版
//
// 当前清空批次/偏差（项目刚启动，无批次数据）。
// 设备资源仍保留（在 resources.ts），状态全置「空闲」。
// 验证通过加 P2/P3 后，再按需补回批次数据。

import type { Batch, EquipmentStatus, BatchDeviation } from '../types'

const today = new Date()
const day = (offset: number) => { const d = new Date(today); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10) }

// ============= 批次（暂空）=============
export const batches: Batch[] = []

// ============= 设备实时状态（10 台 r1-r10 全部空闲）=============

export const equipmentStatus: EquipmentStatus[] = [
  { resourceId: 'r1', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(45) },
  { resourceId: 'r2', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(60) },
  { resourceId: 'r3', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(20) },
  { resourceId: 'r4', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(2) },
  { resourceId: 'r5', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(75) },
  { resourceId: 'r6', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(35) },
  { resourceId: 'r7', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(35) },
  { resourceId: 'r8', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(120) },
  { resourceId: 'r9', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(50) },
  { resourceId: 'r10', status: '空闲', utilizationRate7d: 0, maintenanceDue: day(7) },
]

// ============= 批次偏差（暂空）=============
export const batchDeviations: BatchDeviation[] = []
