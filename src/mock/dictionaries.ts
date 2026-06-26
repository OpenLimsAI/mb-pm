// 数据字典（FR-AD-002）
import type { Stage, Module, ProductType, TaskStatus, Priority, SpecialtyGroup } from '../types'

export const stages: Stage[] = ['临床前', 'IND', 'Ph1/2', 'Ph3', 'BLA', '商业化', '上市后']

export const modules: Module[] = ['细胞株', 'USP', 'DSP', 'DP', '分析方法', '稳定性', '工艺验证', 'CTD', '其他']

export const productTypes: ProductType[] = ['单抗', '多抗', '其他']

export const taskStatuses: TaskStatus[] = ['未开始', '进行中', '阻塞', '延迟', '已完成', '已验证']

export const priorities: Priority[] = ['高', '中', '低']

export const specialtyGroups: SpecialtyGroup[] = ['上游', '下游', '制剂', '分析', '稳定性', '工艺验证', 'CMC综合']

// 专业组 → 模块映射（用于人员推荐 FR-SW-002）
export const groupToModules: Record<SpecialtyGroup, Module[]> = {
  '上游': ['USP', '细胞株'],
  '下游': ['DSP'],
  '制剂': ['DP'],
  '分析': ['分析方法'],
  '稳定性': ['稳定性'],
  '工艺验证': ['工艺验证'],
  'CMC综合': ['CTD', '其他'],
}

// 阶段 × 模块矩阵（附录 12.1）
// true = 该阶段需要该模块
export const stageModuleMatrix: Record<Module, Record<Stage, boolean>> = {
  '细胞株':   { '临床前': true,  'IND': false, 'Ph1/2': false, 'Ph3': false, 'BLA': false, '商业化': false, '上市后': false },
  'USP':      { '临床前': false, 'IND': true,  'Ph1/2': true,  'Ph3': true,  'BLA': false, '商业化': false, '上市后': false },
  'DSP':      { '临床前': false, 'IND': true,  'Ph1/2': true,  'Ph3': true,  'BLA': false, '商业化': false, '上市后': false },
  'DP':       { '临床前': false, 'IND': true,  'Ph1/2': true,  'Ph3': true,  'BLA': true,  '商业化': false, '上市后': false },
  '分析方法': { '临床前': true,  'IND': true,  'Ph1/2': true,  'Ph3': true,  'BLA': true,  '商业化': false, '上市后': false },
  '稳定性':   { '临床前': false, 'IND': true,  'Ph1/2': true,  'Ph3': true,  'BLA': true,  '商业化': false, '上市后': false },
  '工艺验证': { '临床前': false, 'IND': false, 'Ph1/2': false, 'Ph3': true,  'BLA': true,  '商业化': false, '上市后': false },
  'CTD':      { '临床前': false, 'IND': true,  'Ph1/2': false, 'Ph3': false, 'BLA': true,  '商业化': false, '上市后': false },
  '其他':     { '临床前': false, 'IND': false, 'Ph1/2': false, 'Ph3': false, 'BLA': false, '商业化': true,  '上市后': true  },
}
