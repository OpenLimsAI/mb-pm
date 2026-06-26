// 模板列表 — Lite 版
//
// 当前唯一的标准模板：DMP v3.6「原液工艺开发」
// 之前的「单抗 IND 模板」/「双特异性抗体 IND 模板」已废弃删除（2026-05-09）。

import type { Template } from '../types'
import { dmpDrugSubstanceStructure } from './templates-dmp'

export const templates: Template[] = [
  {
    id: 't-dmp-ds',
    name: '原液工艺开发（DMP v3.6 标准）',
    productType: '单抗',
    currentVersion: 'V3.6',
    description: '基于 CMC Development Master Plan v3.6 第 3 章「原液工艺开发」标准化录入 — 33 任务（15 USP 上游 + 18 DSP 下游），含 CTD 章节映射 / 监管依据 / 成本预算 / 关键里程碑标识',
    isActive: true,
    createdBy: 'u2',
    createdAt: '2026-05-09T08:00:00Z',
    updatedAt: '2026-05-09T08:00:00Z',
    versions: [
      {
        id: 'v-dmp-ds-3.6',
        templateId: 't-dmp-ds',
        versionNumber: 'V3.6',
        structureJson: dmpDrugSubstanceStructure,
        changeSummary: '初始版本：从 DMP v3.6「01_总表」第 3 章录入 33 任务，含完整字段（CTD 章节 / 输出物 / 监管依据 / 成本预算 / 协作部门）',
        changeSource: 'excel_import',
        modifiedBy: 'u2',
        modifiedAt: '2026-05-09T08:00:00Z',
        isCurrent: true,
      },
    ],
  },
]
