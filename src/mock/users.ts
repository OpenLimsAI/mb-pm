import type { User } from '../types'

export const users: User[] = [
  { id: 'u1', username: 'admin', displayName: '张管理', email: 'admin@cmc.com', role: 'admin', weeklyAvailableHours: 40, isActive: true, avatarColor: '#64748b' },
  { id: 'u2', username: 'guo.cmc', displayName: '郭主任', email: 'guo@cmc.com', role: 'cmc_lead', specialtyGroup: 'CMC综合', weeklyAvailableHours: 40, isActive: true, avatarColor: '#2563eb' },
  { id: 'u3', username: 'li.pm1', displayName: '李项目', email: 'li.pm@cmc.com', role: 'project_lead', specialtyGroup: 'CMC综合', weeklyAvailableHours: 40, isActive: true, avatarColor: '#0ea5e9' },
  { id: 'u4', username: 'zhao.pm2', displayName: '赵项目', email: 'zhao.pm@cmc.com', role: 'project_lead', specialtyGroup: 'CMC综合', weeklyAvailableHours: 40, isActive: true, avatarColor: '#06b6d4' },
  { id: 'u5', username: 'chen.pm3', displayName: '陈项目', email: 'chen.pm@cmc.com', role: 'project_lead', specialtyGroup: 'CMC综合', weeklyAvailableHours: 40, isActive: true, avatarColor: '#14b8a6' },

  { id: 'u6', username: 'liu.usp1', displayName: '刘上游', email: 'liu.usp@cmc.com', role: 'rd', specialtyGroup: '上游', weeklyAvailableHours: 40, isActive: true, avatarColor: '#10b981' },
  { id: 'u7', username: 'sun.usp2', displayName: '孙上游', email: 'sun.usp@cmc.com', role: 'rd', specialtyGroup: '上游', weeklyAvailableHours: 40, isActive: true, avatarColor: '#22c55e' },
  { id: 'u8', username: 'wu.dsp1', displayName: '吴下游', email: 'wu.dsp@cmc.com', role: 'rd', specialtyGroup: '下游', weeklyAvailableHours: 40, isActive: true, avatarColor: '#84cc16' },
  { id: 'u9', username: 'zhou.dsp2', displayName: '周下游', email: 'zhou.dsp@cmc.com', role: 'rd', specialtyGroup: '下游', weeklyAvailableHours: 40, isActive: true, avatarColor: '#a3e635' },
  { id: 'u10', username: 'qian.dp1', displayName: '钱制剂', email: 'qian.dp@cmc.com', role: 'rd', specialtyGroup: '制剂', weeklyAvailableHours: 40, isActive: true, avatarColor: '#eab308' },
  { id: 'u11', username: 'feng.dp2', displayName: '冯制剂', email: 'feng.dp@cmc.com', role: 'rd', specialtyGroup: '制剂', weeklyAvailableHours: 40, isActive: true, avatarColor: '#f59e0b' },

  { id: 'u12', username: 'jiang.ana1', displayName: '蒋分析', email: 'jiang.ana@cmc.com', role: 'rd', specialtyGroup: '分析', weeklyAvailableHours: 40, isActive: true, avatarColor: '#f97316' },
  { id: 'u13', username: 'han.ana2', displayName: '韩分析', email: 'han.ana@cmc.com', role: 'rd', specialtyGroup: '分析', weeklyAvailableHours: 40, isActive: true, avatarColor: '#ef4444' },
  { id: 'u14', username: 'tang.ana3', displayName: '唐分析', email: 'tang.ana@cmc.com', role: 'rd', specialtyGroup: '分析', weeklyAvailableHours: 40, isActive: true, avatarColor: '#ec4899' },

  { id: 'u15', username: 'feng.stab', displayName: '冯稳定', email: 'feng.stab@cmc.com', role: 'rd', specialtyGroup: '稳定性', weeklyAvailableHours: 40, isActive: true, avatarColor: '#d946ef' },
  { id: 'u16', username: 'shen.val', displayName: '沈验证', email: 'shen.val@cmc.com', role: 'rd', specialtyGroup: '工艺验证', weeklyAvailableHours: 40, isActive: true, avatarColor: '#a855f7' },

  { id: 'u17', username: 'mao.prod1', displayName: '毛生产', email: 'mao.prod@cmc.com', role: 'production', weeklyAvailableHours: 40, isActive: true, avatarColor: '#8b5cf6' },
  { id: 'u18', username: 'cao.prod2', displayName: '曹生产', email: 'cao.prod@cmc.com', role: 'production', weeklyAvailableHours: 40, isActive: true, avatarColor: '#6366f1' },

  // QA/QC（URS 5.1 预留角色 — 已落地）
  { id: 'u19', username: 'qa.zhao', displayName: '赵质量', email: 'qa.zhao@cmc.com', role: 'qa_qc', specialtyGroup: '分析', weeklyAvailableHours: 40, isActive: true, avatarColor: '#dc2626' },
  { id: 'u20', username: 'qc.li',   displayName: '李质量', email: 'qc.li@cmc.com',   role: 'qa_qc', specialtyGroup: '分析', weeklyAvailableHours: 40, isActive: true, avatarColor: '#b91c1c' },

  // 项目团队成员示例（跨职能协作）
  { id: 'u21', username: 'zhang.san', displayName: '张三', email: 'zhang.san@cmc.com', role: 'rd', specialtyGroup: '上游', weeklyAvailableHours: 40, isActive: true, avatarColor: '#0891b2' },
  { id: 'u22', username: 'li.si',     displayName: '李四', email: 'li.si@cmc.com',     role: 'rd', specialtyGroup: '下游', weeklyAvailableHours: 40, isActive: true, avatarColor: '#0d9488' },
]

// 6 个角色的演示账号（用于登录页）
export const demoAccounts = [
  { role: 'admin' as const, username: 'admin', user: users[0], description: '系统管理员（用户/字典/模板/系统配置）' },
  { role: 'cmc_lead' as const, username: 'guo.cmc', user: users[1], description: 'CMC 负责人（全局组合管理 + 模板维护）' },
  { role: 'project_lead' as const, username: 'li.pm1', user: users[2], description: '项目负责人（单项目全周期）' },
  { role: 'rd' as const, username: 'liu.usp1', user: users[5], description: '工艺开发（任务执行）' },
  { role: 'production' as const, username: 'mao.prod1', user: users[16], description: '生产支持（设备日历 + 批次跟踪）' },
  { role: 'qa_qc' as const, username: 'qa.zhao', user: users[18], description: 'QA/QC（批次放行 + 偏差审核 + 分析任务跟踪）' },
]
