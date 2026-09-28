// 项目列表 — Lite 版
//
// 全部 3 个项目均使用 DMP v3.6 标准模板（t-dmp-ds）实例化。
// 任务结构 100% 镜像模板：每个项目都有 33 任务 + 38 依赖 + 7 里程碑 + 11 关键路径。
//
// 项目之间的差异仅在：plannedStart（决定时间线）/ ownerId（项目负责人）/
// 任务负责人（按角色映射到不同的 rd 用户）。
//
// 三个项目的演示画像（按 today=2026-05-10 设计；现「今日」取本机日期，状态 / 健康度会随日期推移）：
//   P1 MAB-201 (green)：临床前末段 → 即将进入 IND；USP 大部分完成、DSP 早期启动
//   P2 MAB-202 (yellow)：IND 完成 → 进入 PC 阶段；DSP 工艺已锁定，多个 Ph3 准备任务并行进行中
//   P3 MAB-203 (green)：项目刚启动 ~3 个月；USP 早期培养基筛选阶段
//
// 旧的 8 个 CMAB 项目已全部废弃删除（2026-05-09）。

import type { Project } from '../types'

export const projects: Project[] = [
  {
    id: 'p1',
    code: 'MAB-201',
    name: 'MAB-201 抗HER2单抗（基于 DMP 模板）',
    productType: '单抗',
    currentStage: '临床前',
    targetStage: 'BLA',
    ownerId: 'u3',  // 李项目
    status: '活跃',
    health: 'green',
    plannedStart: '2025-09-01',
    plannedEnd: '2028-06-30',
    templateId: 't-dmp-ds',
    templateVersion: 'V3.6',
    description: '从 DMP v3.6「3. 原液工艺开发」标准模板实例化创建 — 含 33 任务（15 USP + 18 DSP）',
    progress: 27,  // USP-001~007 完成 + USP-009 进行中
  },
  {
    id: 'p2',
    code: 'MAB-202',
    name: 'MAB-202 抗PD-L1单抗（基于 DMP 模板）',
    productType: '单抗',
    currentStage: 'IND',
    targetStage: 'BLA',
    ownerId: 'u4',  // 赵项目
    status: '活跃',
    health: 'yellow',
    plannedStart: '2024-11-01',
    plannedEnd: '2027-09-30',
    templateId: 't-dmp-ds',
    templateVersion: 'V3.6',
    description: '从 DMP v3.6 模板实例化 — 含 33 任务，DSP 工艺已基本完成，进入 PC（工艺表征）阶段，多任务并行进行中',
    progress: 65,
  },
  {
    id: 'p3',
    code: 'MAB-203',
    name: 'MAB-203 抗CD20单抗（基于 DMP 模板）',
    productType: '单抗',
    currentStage: '临床前',
    targetStage: 'IND',
    ownerId: 'u5',  // 陈项目
    status: '活跃',
    health: 'green',
    plannedStart: '2026-02-01',
    plannedEnd: '2028-12-31',
    templateId: 't-dmp-ds',
    templateVersion: 'V3.6',
    description: '从 DMP v3.6 模板实例化 — 含 33 任务，处于 USP 早期开发阶段',
    progress: 10,
  },
]
