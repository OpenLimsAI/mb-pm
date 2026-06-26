// 资源 + 占用 + 预警 + 审计 — Lite 版
//
// 当前：资源池 10 台保留；占用/预警清空；审计仅保留 2 条（模板录入 + 项目创建）

import type { Resource, ResourceBooking, Alert, AuditLog } from '../types'

export const resources: Resource[] = [
  { id: 'r1', name: '生物反应器 A（500L）', type: '设备', location: '中试车间', isActive: true },
  { id: 'r2', name: '生物反应器 B（500L）', type: '设备', location: '中试车间', isActive: true },
  { id: 'r3', name: '生物反应器 C（200L）', type: '设备', location: '研发中心', isActive: true },
  { id: 'r4', name: '层析柱（Protein A）', type: '设备', location: '下游实验室', isActive: true },
  { id: 'r5', name: '层析柱（IEX）', type: '设备', location: '下游实验室', isActive: true },
  { id: 'r6', name: 'HPLC-1（活性方法）', type: '设备', location: '分析实验室', isActive: true },
  { id: 'r7', name: 'HPLC-2（纯度方法）', type: '设备', location: '分析实验室', isActive: true },
  { id: 'r8', name: '稳定性试验箱', type: '设备', location: '稳定性中心', isActive: true },
  { id: 'r9', name: '中试灌装产线', type: '产线', location: '中试车间', isActive: true },
  { id: 'r10', name: '商业化生产线 A', type: '产线', location: '商业化车间', isActive: true },
]

// ============= 资源占用（暂空）=============
export const resourceBookings: ResourceBooking[] = []

// ============= 预警（暂空）=============
export const alerts: Alert[] = []

// ============= 审计日志 =============

export const auditLogs: AuditLog[] = [
  {
    id: 'log1', actorId: 'u2', action: '模板录入', target: '模板', targetId: 't-dmp-ds',
    detail: '从 DMP v3.6.xlsx 导入「3. 原液工艺开发」33 任务作为标准模板',
    createdAt: '2026-05-09T08:00:00Z',
  },
  {
    id: 'log2', actorId: 'u3', action: '项目创建', target: '项目', targetId: 'p1',
    detail: '基于 DMP v3.6 模板「原液工艺开发（V3.6）」创建 MAB-201 抗HER2单抗 — 自动实例化 33 任务、38 依赖、7 里程碑、11 关键路径',
    createdAt: '2025-09-01T09:00:00Z',
  },
  {
    id: 'log3', actorId: 'u4', action: '项目创建', target: '项目', targetId: 'p2',
    detail: '基于 DMP v3.6 模板「原液工艺开发（V3.6）」创建 MAB-202 抗PD-L1单抗 — 自动实例化 33 任务、38 依赖、7 里程碑、11 关键路径',
    createdAt: '2024-11-01T09:00:00Z',
  },
  {
    id: 'log4', actorId: 'u5', action: '项目创建', target: '项目', targetId: 'p3',
    detail: '基于 DMP v3.6 模板「原液工艺开发（V3.6）」创建 MAB-203 抗CD20单抗 — 自动实例化 33 任务、38 依赖、7 里程碑、11 关键路径',
    createdAt: '2026-02-01T09:00:00Z',
  },
]
