// DMP v3.6 — 原液工艺开发标准模板
//
// 数据来源: CMC Development Master Plan (DMP) v3.6.xlsx — 「01_总表」「3. 原液工艺开发」
// 共 33 个任务（15 USP 上游 + 18 DSP 下游）
//
// 包含的 DMP 扩展字段：
//   - taskCode      : DMP 任务 ID（USP-001 / DSP-001 …）
//   - description   : 任务描述
//   - ctdSection    : 对齐 ICH M4Q 章节号
//   - output        : 输出物
//   - regulatoryRef : 监管依据
//   - costBudget    : 成本预算（万元）
//   - collaborators : 协作部门
//   - milestoneLabel: 关键里程碑文字
//   - isCriticalPath: 是否在关键路径上
//
// defaultDuration 单位：已从 DMP 的"常规耗时(周)" 转换为天（× 7）。
// 阶段门 → Stage 映射:
//   Discovery / Pre-IND → 临床前
//   IND/Ph1             → IND
//   Ph2                 → Ph1/2
//   Ph3 / PPQ           → Ph3
//   BLA                 → BLA
//   Post-approval       → 上市后

import type { TemplateNode } from '../types'

export const dmpDrugSubstanceStructure: TemplateNode = {
  id: 'root',
  name: '原液工艺开发（DMP v3.6 标准模板）',
  children: [
    {
      id: 'sp-usp',
      name: '上游工艺开发 (USP) — 15 任务',
      stage: 'Ph3',  // 跨阶段，标记 Ph3 为最晚阶段
      module: 'USP',
      children: [
          { id: 'USP-001', taskCode: 'USP-001', name: '平台培养基与补料筛选', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 42, defaultEffort: 3, isMilestone: false, description: '基础培养基/补料体系的平台评估，筛选 2~3 组合', ctdSection: '3.2.S.2.2', output: 'Media screening report', regulatoryRef: '内部 SOP', costBudget: 40, collaborators: ['AS'], isCriticalPath: true, predecessors: [{ taskCode: 'CLD-007', type: 'FS', lagDays: 0 }] },
          { id: 'USP-002', taskCode: 'USP-002', name: '摇瓶 fed-batch 初筛', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 28, defaultEffort: 3, isMilestone: false, description: '克隆/培养基组合的摇瓶 fed-batch 评价', ctdSection: '3.2.S.2.6', output: 'SF screening data', regulatoryRef: '内部 SOP', costBudget: 30, predecessors: [{ taskCode: 'USP-001', type: 'FS', lagDays: 0 }] },
          { id: 'USP-003', taskCode: 'USP-003', name: 'Ambr® 小规模多平行筛选', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 56, defaultEffort: 4, isMilestone: false, description: 'Ambr®15/250 高通量工艺筛选', ctdSection: '3.2.S.2.6', output: 'Ambr DOE report', regulatoryRef: '内部 SOP', costBudget: 120, predecessors: [{ taskCode: 'USP-002', type: 'FS', lagDays: 0 }] },
          { id: 'USP-004', taskCode: 'USP-004', name: '接种密度与扩增策略 DOE', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 28, defaultEffort: 3, isMilestone: false, description: 'N-1/N 接种密度、扩增时间、传代次数 DOE', ctdSection: '3.2.S.2.6', output: 'Inoculation DOE report', regulatoryRef: 'QbD 实践', costBudget: 60, predecessors: [{ taskCode: 'USP-003', type: 'FS', lagDays: 0 }] },
          { id: 'USP-005', taskCode: 'USP-005', name: '补料策略 DOE', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 42, defaultEffort: 3, isMilestone: false, description: '补料时间/次数/总量 DOE', ctdSection: '3.2.S.2.6', output: 'Feeding DOE report', regulatoryRef: 'QbD 实践', costBudget: 80, isCriticalPath: true, predecessors: [{ taskCode: 'USP-003', type: 'FS', lagDays: 0 }] },
          { id: 'USP-006', taskCode: 'USP-006', name: '温度/pH/DO DOE', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 42, defaultEffort: 4, isMilestone: false, description: '关键环境参数 DOE，含降温策略', ctdSection: '3.2.S.2.6', output: 'Env param DOE report', regulatoryRef: 'QbD 实践', costBudget: 80, predecessors: [{ taskCode: 'USP-005', type: 'FS', lagDays: 0 }] },
          { id: 'USP-007', taskCode: 'USP-007', name: '生产模式与工艺锁定 (fed-batch/perfusion)', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 21, defaultEffort: 3, isMilestone: true, description: '综合 DOE 结果锁定工艺', ctdSection: '3.2.S.2.2', output: 'USP Process Description v1', regulatoryRef: 'ICH Q11', costBudget: 30, collaborators: ['AS'], milestoneLabel: '上游工艺定型', isCriticalPath: true, predecessors: [{ taskCode: 'USP-006', type: 'FS', lagDays: 0 }] },
          { id: 'USP-008', taskCode: 'USP-008', name: '种子扩增工艺开发', module: 'USP', stage: 'IND', defaultRole: '上游', defaultDuration: 28, defaultEffort: 2, isMilestone: false, description: 'Seed train 扩增比例/体积/传代时长', ctdSection: '3.2.S.2.2', output: 'Seed train design', regulatoryRef: '内部 SOP', costBudget: 40, predecessors: [{ taskCode: 'USP-007', type: 'FS', lagDays: 0 }] },
          { id: 'USP-009', taskCode: 'USP-009', name: '2L 小罐工艺确认', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 42, defaultEffort: 3, isMilestone: false, description: '2L 生物反应器工艺参数确认', ctdSection: '3.2.S.2.6', output: '2L confirmation report', regulatoryRef: '内部 SOP', costBudget: 60, isCriticalPath: true, predecessors: [{ taskCode: 'USP-007', type: 'FS', lagDays: 0 }] },
          { id: 'USP-010', taskCode: 'USP-010', name: '50L 代表性备样批', module: 'USP', stage: '临床前', defaultRole: '上游', defaultDuration: 42, defaultEffort: 4, isMilestone: true, description: '50L 规模代表性批次，为 DSP 和分析提供原料', ctdSection: '3.2.S.2.4', output: '50L TT report', regulatoryRef: '内部 SOP', costBudget: 150, collaborators: ['DSP', 'AS'], milestoneLabel: 'DSP 备样到位', predecessors: [{ taskCode: 'USP-009', type: 'FS', lagDays: 0 }] },
          { id: 'USP-011', taskCode: 'USP-011', name: '上游缩小模型 (SDM) 鉴定', module: 'USP', stage: 'Ph3', defaultRole: '上游', defaultDuration: 70, defaultEffort: 4, isMilestone: true, description: 'SDM 与预期生产规模的代表性确认（生长/滴度/PQ）', ctdSection: '3.2.S.2.6', output: 'USP SDM qualification report', regulatoryRef: 'BioPhorum PC; QbD 实践', costBudget: 80, collaborators: ['AS'], milestoneLabel: 'USP SDM 鉴定', isCriticalPath: true, predecessors: [{ taskCode: 'PC-001', type: 'FS', lagDays: 0 }, { taskCode: 'TT-002', type: 'FS', lagDays: 0 }] },
          { id: 'USP-012', taskCode: 'USP-012', name: '上游中间体 Hold Time 研究', module: 'USP', stage: 'Ph3', defaultRole: '上游', defaultDuration: 42, defaultEffort: 2, isMilestone: false, description: '接种前种子/收获液保存时间与条件', ctdSection: '3.2.S.2.4', output: 'Hold time report', regulatoryRef: 'ICH Q7', costBudget: 30, collaborators: ['AS'], predecessors: [{ taskCode: 'USP-007', type: 'FS', lagDays: 0 }] },
          { id: 'USP-013', taskCode: 'USP-013', name: '上游原材料清单与备用源', module: 'USP', stage: 'Ph3', defaultRole: '上游', defaultDuration: 28, defaultEffort: 2, isMilestone: false, description: '关键原材料（培养基/补料/消泡剂等）清单、供应商、备用源策略', ctdSection: '3.2.S.2.3', output: 'USP RM list', regulatoryRef: 'ICH Q11', costBudget: 20, collaborators: ['RM'], predecessors: [{ taskCode: 'USP-007', type: 'FS', lagDays: 0 }] },
          { id: 'USP-014', taskCode: 'USP-014', name: '澄清收获工艺开发', module: 'USP', stage: 'IND', defaultRole: '上游', defaultDuration: 28, defaultEffort: 3, isMilestone: false, description: '离心/深层过滤/絮凝等澄清策略', ctdSection: '3.2.S.2.2', output: 'Harvest dev report', regulatoryRef: '内部 SOP', costBudget: 50, collaborators: ['DSP'], predecessors: [{ taskCode: 'USP-010', type: 'FS', lagDays: 0 }] },
          { id: 'USP-015', taskCode: 'USP-015', name: '上游工艺描述与流程图', module: 'USP', stage: 'Ph3', defaultRole: '上游', defaultDuration: 28, defaultEffort: 2, isMilestone: false, description: '工艺描述、流程图、参数范围', ctdSection: '3.2.S.2.2', output: 'USP Process Description v2', regulatoryRef: 'ICH Q11; M3.2.S.2.2', costBudget: 10, collaborators: ['RA'], predecessors: [{ taskCode: 'USP-007', type: 'FS', lagDays: 0 }, { taskCode: 'USP-014', type: 'FS', lagDays: 0 }] },
      ],
    },
    {
      id: 'sp-dsp',
      name: '下游工艺开发 (DSP) — 18 任务',
      stage: 'Ph3',  // 跨阶段，标记 Ph3 为最晚阶段
      module: 'DSP',
      children: [
          { id: 'DSP-001', taskCode: 'DSP-001', name: '下游平台工艺方案', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 14, defaultEffort: 2, isMilestone: false, description: '基于分子类型确定下游步骤组合（捕获/VI/层析/VF/UFDF）', ctdSection: '3.2.S.2.2', output: 'DSP strategy doc', regulatoryRef: '内部 SOP', costBudget: 20, collaborators: ['AS'], predecessors: [{ taskCode: 'RD-003', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-002', taskCode: 'DSP-002', name: '捕获层析开发 (Protein A)', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 56, defaultEffort: 3, isMilestone: false, description: '树脂筛选、载量/流速/缓冲体系/洗脱/CIP 条件', ctdSection: '3.2.S.2.2', output: 'Capture dev report', regulatoryRef: 'ICH Q11', costBudget: 100, isCriticalPath: true, predecessors: [{ taskCode: 'DSP-001', type: 'FS', lagDays: 0 }, { taskCode: 'USP-010', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-003', taskCode: 'DSP-003', name: '低 pH 病毒灭活工艺开发', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 28, defaultEffort: 2, isMilestone: false, description: 'pH/时间/温度/缓冲体系确定', ctdSection: '3.2.A.2', output: 'VI dev report', regulatoryRef: 'ICH Q5A(R2)', costBudget: 30, collaborators: ['AS'], predecessors: [{ taskCode: 'DSP-002', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-004', taskCode: 'DSP-004', name: '中间纯化层析开发', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 56, defaultEffort: 3, isMilestone: false, description: 'AEX/CEX/HIC 筛选与优化', ctdSection: '3.2.S.2.2', output: 'Intermediate chrom report', regulatoryRef: 'ICH Q11', costBudget: 80, isCriticalPath: true, predecessors: [{ taskCode: 'DSP-003', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-005', taskCode: 'DSP-005', name: '精纯层析开发', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 42, defaultEffort: 3, isMilestone: false, description: '第二步/第三步层析，杂质精纯', ctdSection: '3.2.S.2.2', output: 'Polishing dev report', regulatoryRef: 'ICH Q11', costBudget: 80, isCriticalPath: true, predecessors: [{ taskCode: 'DSP-004', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-006', taskCode: 'DSP-006', name: '病毒过滤工艺开发', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 28, defaultEffort: 2, isMilestone: false, description: '纳滤膜选型（15~20 nm）、载量/压力/预过滤', ctdSection: '3.2.A.2', output: 'VF dev report', regulatoryRef: 'ICH Q5A(R2)', costBudget: 60, predecessors: [{ taskCode: 'DSP-005', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-007', taskCode: 'DSP-007', name: 'UF/DF 工艺开发', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 28, defaultEffort: 3, isMilestone: false, description: '膜包选型、浓缩倍数、换液倍数、终浓度', ctdSection: '3.2.S.2.2', output: 'UFDF dev report', regulatoryRef: '内部 SOP', costBudget: 50, collaborators: ['DPS'], isCriticalPath: true, predecessors: [{ taskCode: 'DSP-006', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-008', taskCode: 'DSP-008', name: '下游耗材选型', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 28, defaultEffort: 2, isMilestone: true, description: '深层过滤/除菌/除病毒/超滤/中间体袋/原液袋', ctdSection: '3.2.S.2.6', output: 'Consumables selection report', regulatoryRef: '内部 SOP', costBudget: 30, milestoneLabel: '下游耗材定型', predecessors: [{ taskCode: 'DSP-007', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-009', taskCode: 'DSP-009', name: '层析填料寿命研究', module: 'DSP', stage: 'Ph3', defaultRole: '下游', defaultDuration: 84, defaultEffort: 4, isMilestone: true, description: '树脂多循环载量/杂质去除/动态结合能力', ctdSection: '3.2.S.2.5', output: 'Resin lifetime report', regulatoryRef: 'ICH Q7; 业界实践', costBudget: 80, collaborators: ['AS'], milestoneLabel: '填料寿命通过', predecessors: [{ taskCode: 'DSP-002', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-004', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-005', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-010', taskCode: 'DSP-010', name: '下游中间体 Hold Time', module: 'DSP', stage: 'Ph3', defaultRole: '下游', defaultDuration: 42, defaultEffort: 2, isMilestone: false, description: '各步中间体保存时间与条件', ctdSection: '3.2.S.2.4', output: 'Intermediate hold time report', regulatoryRef: 'ICH Q7', costBudget: 30, collaborators: ['AS'], predecessors: [{ taskCode: 'DSP-007', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-011', taskCode: 'DSP-011', name: '下游 SDM 鉴定', module: 'DSP', stage: 'Ph3', defaultRole: '下游', defaultDuration: 70, defaultEffort: 4, isMilestone: true, description: '层析/TFF 缩小模型与生产规模代表性确认', ctdSection: '3.2.S.2.6', output: 'DSP SDM qualification report', regulatoryRef: 'BioPhorum PC', costBudget: 80, collaborators: ['AS'], milestoneLabel: 'DSP SDM 鉴定', isCriticalPath: true, predecessors: [{ taskCode: 'PC-001', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-012', taskCode: 'DSP-012', name: '原液处方缓冲液交换', module: 'DSP', stage: 'IND', defaultRole: '下游', defaultDuration: 21, defaultEffort: 2, isMilestone: false, description: '与 FS 联动，原液终缓冲体系', ctdSection: '3.2.S.2.2', output: 'DS buffer exchange SOP', regulatoryRef: '内部 SOP', costBudget: 30, collaborators: ['DPS'], predecessors: [{ taskCode: 'DSP-007', type: 'FS', lagDays: 0 }, { taskCode: 'FM-006', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-013', taskCode: 'DSP-013', name: '原液储存容器与冻融研究', module: 'DSP', stage: 'Ph1/2', defaultRole: '下游', defaultDuration: 42, defaultEffort: 3, isMilestone: false, description: 'DS 袋/瓶/大规模冻存容器评估，冻融次数评价', ctdSection: '3.2.S.2.4', output: 'DS container & freeze-thaw report', regulatoryRef: 'USP <1207>; 内部 SOP', costBudget: 40, collaborators: ['DPS', 'AS'], predecessors: [{ taskCode: 'DSP-012', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-014', taskCode: 'DSP-014', name: '下游工艺锁定', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 21, defaultEffort: 3, isMilestone: true, description: '综合数据锁定下游工艺', ctdSection: '3.2.S.2.2', output: 'DSP Process Description v1', regulatoryRef: 'ICH Q11', costBudget: 20, collaborators: ['AS', 'RA'], milestoneLabel: '下游工艺定型', isCriticalPath: true, predecessors: [{ taskCode: 'DSP-002', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-003', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-004', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-005', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-006', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-007', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-015', taskCode: 'DSP-015', name: '50L 下游代表性批次', module: 'DSP', stage: '临床前', defaultRole: '下游', defaultDuration: 42, defaultEffort: 4, isMilestone: false, description: '与 USP-010 联动，50L 全流程代表性批', ctdSection: '3.2.S.2.4', output: '50L DSP report', regulatoryRef: '内部 SOP', costBudget: 150, collaborators: ['UPS', 'AS'], predecessors: [{ taskCode: 'USP-010', type: 'FS', lagDays: 0 }, { taskCode: 'DSP-014', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-016', taskCode: 'DSP-016', name: '下游原材料清单与备用源', module: 'DSP', stage: 'Ph3', defaultRole: '下游', defaultDuration: 28, defaultEffort: 2, isMilestone: false, description: '树脂/膜/缓冲盐/消毒剂清单、供应商、备用源', ctdSection: '3.2.S.2.3', output: 'DSP RM list', regulatoryRef: 'ICH Q11', costBudget: 20, collaborators: ['RM'], predecessors: [{ taskCode: 'DSP-014', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-017', taskCode: 'DSP-017', name: '下游工艺描述与流程图', module: 'DSP', stage: 'Ph3', defaultRole: '下游', defaultDuration: 28, defaultEffort: 2, isMilestone: false, description: '工艺描述、流程图、参数范围', ctdSection: '3.2.S.2.2', output: 'DSP Process Description v2', regulatoryRef: 'ICH Q11; M3.2.S.2.2', costBudget: 10, collaborators: ['RA'], predecessors: [{ taskCode: 'DSP-014', type: 'FS', lagDays: 0 }] },
          { id: 'DSP-018', taskCode: 'DSP-018', name: '下游 CPP/KPP 评估', module: 'DSP', stage: 'Ph3', defaultRole: '下游', defaultDuration: 28, defaultEffort: 3, isMilestone: false, description: '基于 PC 数据的 CPP/KPP 分级', ctdSection: '3.2.S.2.6', output: 'DSP CPP/KPP report', regulatoryRef: 'ICH Q8(R2); Q11', costBudget: 40, collaborators: ['AS'], predecessors: [{ taskCode: 'PC-008', type: 'FS', lagDays: 0 }] },
      ],
    },
  ],
}
