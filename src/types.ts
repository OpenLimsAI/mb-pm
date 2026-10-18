// CMC-PMS 全局类型定义（与 URS 第7节数据模型一致）

// 账号管理按三类身份分配：系统管理员 = admin；项目负责人 = cmc_lead；员工 = 不分配项目管理角色（登录时默认 rd）。
// project_lead / production / qa_qc 为旧角色，仍兼容。
export type Role =
  | 'admin'         // 系统管理员
  | 'cmc_lead'      // 项目负责人（管理全部项目：编辑项目（预算与 WBS 结构）、删除项目等；原「CMC 负责人」）
  | 'project_lead'  // 项目负责人（仅本人项目，旧角色）
  | 'rd'            // 员工（默认：更新本人任务等日常录入；原「工艺开发」）
  | 'production'    // 生产支持人员
  | 'qa_qc'         // QA/QC 人员（分析任务跟踪 / 批次放行 / 偏差审核）

export type ProductType = '单抗' | '多抗' | '其他'

export type ProjectStatus = '活跃' | '暂停' | '已完成' | '已归档'

export type Health = 'green' | 'yellow' | 'red'

export type TaskStatus = '未开始' | '进行中' | '阻塞' | '延迟' | '已完成' | '已验证'

export type Priority = '高' | '中' | '低'

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

export type Stage =
  | '临床前' | 'IND' | 'Ph1/2' | 'Ph3' | 'BLA' | '商业化' | '上市后'

export type Module =
  | '细胞株' | 'USP' | 'DSP' | 'DP'
  | '分析方法' | '稳定性' | '工艺验证' | 'CTD' | '其他'

export type SpecialtyGroup =
  | '上游' | '下游' | '制剂' | '分析' | '稳定性' | '工艺验证' | 'CMC综合'

export interface User {
  id: string
  username: string
  displayName: string
  email: string
  role: Role
  specialtyGroup?: SpecialtyGroup
  weeklyAvailableHours: number
  isActive: boolean
  avatarColor: string
}

export interface Project {
  id: string
  code: string
  name: string
  productType: ProductType
  currentStage: Stage
  targetStage: Stage
  ownerId: string                // 项目负责人（必选）
  memberIds?: string[]           // 项目团队成员（可选，跨职能：上游/下游/制剂/分析/QA 等）
  status: ProjectStatus
  health: Health
  plannedStart: string
  plannedEnd: string
  templateId: string
  templateVersion: string
  description?: string
  progress: number
}

export interface SubProject {
  id: string
  name: string
  projectId: string
  stage: Stage
  module: Module
  ownerId?: string
  status: TaskStatus
  progress: number
  sortOrder: number
}

export interface Task {
  id: string
  code: string
  name: string
  subProjectId: string
  ownerId: string
  collaboratorIds?: string[]
  status: TaskStatus
  priority: Priority
  plannedStart: string
  plannedEnd: string
  actualStart?: string
  actualEnd?: string
  estimatedEffort: number
  actualEffort?: number
  /** 成本预算（万元 RMB，含外包/耗材/CRO，不含内部人力）—— 实例化自模板 costBudget */
  costBudget?: number
  /** 实际花费（万元 RMB）—— 任务执行过程中录入，与 costBudget 对比 */
  actualCost?: number
  progress: number
  isMilestone: boolean
  isCriticalPath: boolean
  notes?: string
  tags?: string[]
  /** 子项目内的手动顺序（WBS 树 / 表格 / 甘特与编辑模式按它排列，见 lib/taskOrder.ts） */
  sortOrder?: number | null
}

export interface TaskDependency {
  id: string
  predecessorId: string
  successorId: string
  type: DependencyType
  lagDays: number
}

export interface TemplateNode {
  id: string
  name: string
  module?: Module
  stage?: Stage
  defaultDuration?: number
  defaultEffort?: number
  isMilestone?: boolean
  defaultRole?: SpecialtyGroup
  notes?: string
  children?: TemplateNode[]
  predecessors?: { taskCode: string; type: DependencyType; lagDays: number }[]
  taskCode?: string

  // —— DMP v3.6 扩展字段（可选）—— //
  /** 任务详细描述（输出 / 方法 / 范围） */
  description?: string
  /** 对齐 ICH M4Q 章节号，治理性活动用 "—" */
  ctdSection?: string
  /** 可交付的输出物 */
  output?: string
  /** 监管依据（ICH/FDA/EMA/NMPA/USP/BioPhorum 引用） */
  regulatoryRef?: string
  /** 成本预算（万元 RMB，含外包/耗材/CRO，不含内部人力） */
  costBudget?: number
  /** 协作部门列表（DMP 主责由 defaultRole 表达；这里是次要配合方） */
  collaborators?: string[]
  /** 关键里程碑文字描述（如"上游工艺定型"） */
  milestoneLabel?: string
  /** 是否在关键路径上（DMP W 列 ★ 标识） */
  isCriticalPath?: boolean
}

export interface Template {
  id: string
  name: string
  productType: ProductType
  currentVersion: string
  description: string
  isActive: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
  versions: TemplateVersion[]
}

export interface TemplateVersion {
  id: string
  templateId: string
  versionNumber: string
  structureJson: TemplateNode
  changeSummary: string
  changeSource: 'visual_edit' | 'excel_import'
  modifiedBy: string
  modifiedAt: string
  isCurrent: boolean
}

export interface Resource {
  id: string
  name: string
  type: '设备' | '产线' | '工位'
  location?: string
  isActive: boolean
}

export interface ResourceBooking {
  id: string
  resourceId: string
  projectId: string
  taskId?: string
  startDate: string
  endDate: string
  bookedBy: string
}

export interface Alert {
  id: string
  type: '任务延迟' | '里程碑风险' | '关键路径变更' | '资源冲突' | '人员过载'
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  projectId?: string
  taskId?: string
  createdAt: string
  isRead: boolean
}

export interface AuditLog {
  id: string
  actorId: string
  action: string
  target: string
  targetId: string
  detail?: string
  createdAt: string
}

// ============= 生产支持扩展（FR-DB-003 强化）=============

/** 批次工序阶段（生物制药通用） */
export type BatchStage =
  | '投料准备'   // staged
  | '上游培养'   // upstream
  | '下游纯化'   // downstream
  | '制剂灌装'   // fill-finish
  | 'QC放行'     // QC release

/** 批次状态 */
export type BatchStatus =
  | '计划中'    // planned
  | '生产中'    // in-production
  | '待放行'    // awaiting QC release
  | '已放行'    // released
  | '拒收'      // rejected
  | '调查中'    // under investigation (deviation)

/** CPP 关键工艺参数记录（实测值 + 规格 + 判定） */
export interface CPPRecord {
  id: string
  parameter: string             // "Day 7 活细胞密度", "DSP Protein A 收率"
  stage: BatchStage
  measuredAt: string            // ISO
  value: number
  unit: string
  specMin?: number
  specMax?: number
  status: 'pass' | 'warning' | 'fail'  // OOS/OOT 判定
  note?: string
}

/** CQA 关键质量属性结果（QC 检测 + 放行标准） */
export interface CQARecord {
  id: string
  attribute: string             // "纯度（SEC-HPLC）"
  method: string                // "SEC-HPLC"
  measuredAt?: string
  value: number | string        // 96.5 或 "符合"
  unit?: string
  spec: string                  // "≥ 95.0%"
  status: 'pass' | 'fail' | 'pending'
  note?: string
}

/** 原料批次追溯（GMP 物料管控） */
export type RawMaterialType = 'cell_line' | 'media' | 'buffer' | 'resin' | 'reference_standard' | 'consumable'

export interface RawMaterial {
  id: string
  type: RawMaterialType
  name: string                  // "CHO-K1 主细胞库"、"Bacto TC YeastoLate"
  lotNumber: string             // "MCB-2024-001"
  vendor?: string
  quantity?: string             // "5L" / "100g" / "1 瓶"
  expiryDate?: string           // YYYY-MM-DD
  receivedAt?: string
  qualified: boolean            // QC 是否放行可用
}

/** 生产批次 */
export interface Batch {
  id: string
  batchCode: string             // 批号（行业标准格式如 CMAB12-PPQ-002）
  projectId: string
  productName: string
  batchType: '工艺验证(PPQ)' | '工程批' | '临床批' | '商业化批' | '稳定性批'
  currentStage: BatchStage
  status: BatchStatus
  plannedStart: string          // YYYY-MM-DD
  plannedEnd: string
  actualStart?: string
  actualRelease?: string
  /** 各工序完成度 0-100 */
  stageProgress: Record<BatchStage, number>
  plannedYield: number          // 计划产量 (g)
  actualYield?: number          // 实际产量
  yieldRate?: number            // 收率 (%)
  ownerId: string               // 批次负责人
  resourceIds: string[]         // 占用的设备
  taskId?: string               // 关联的项目任务
  deviationCount: number        // 关联的偏差数
  notes?: string
  // === GMP 批记录扩展 ===
  cpps?: CPPRecord[]
  cqas?: CQARecord[]
  rawMaterials?: RawMaterial[]
}

/** 设备运行状态（实时） */
export type EquipmentRunStatus = '运行中' | '空闲' | '维护' | '故障' | '清洁中'

export interface EquipmentStatus {
  resourceId: string
  status: EquipmentRunStatus
  currentBatchId?: string       // 正在运行的批次
  operatorId?: string           // 当前操作员
  startedAt?: string            // 当前运行开始时间（ISO）
  runUntilEstimate?: string     // 预计运行至（ISO）
  utilizationRate7d: number     // 近 7 天占用率 (%)
  maintenanceDue?: string       // 下次维护到期日（YYYY-MM-DD）
  notes?: string
}

/** 批次偏差类型 */
export type DeviationType =
  | 'OOS'           // 超出规格 (Out Of Specification)
  | 'OOT'           // 超出趋势 (Out Of Trend)
  | '工艺偏差'      // process deviation
  | '设备故障'
  | '环境监测偏差'

export type DeviationSeverity = 'critical' | 'major' | 'minor'

export type DeviationStatus = '调查中' | 'CAPA中' | '已关闭'

/** 偏差调查时间线条目 */
export interface DeviationInvestigation {
  id: string
  at: string                    // ISO timestamp
  actorId: string
  type: 'report' | 'investigate' | 'rca' | 'capa_plan' | 'capa_execute' | 'verify' | 'close' | 'comment'
  title: string
  detail?: string
}

/** CAPA 行动（Corrective Action / Preventive Action） */
export interface CAPAAction {
  id: string
  kind: 'corrective' | 'preventive'  // 纠正 / 预防
  title: string
  description: string
  ownerId: string
  plannedDate: string                // YYYY-MM-DD
  completedDate?: string
  status: 'open' | 'in_progress' | 'completed' | 'verified'
  effectivenessNote?: string         // 有效性验证记录
}

export interface BatchDeviation {
  id: string
  deviationCode: string         // DEV-2026-001
  batchId: string
  type: DeviationType
  severity: DeviationSeverity
  status: DeviationStatus
  title: string
  description: string
  ownerId: string               // 调查负责人
  reportedAt: string            // ISO
  reporterId?: string           // 首报人（可与 owner 不同）
  dueDate?: string              // CAPA 截止
  closedAt?: string
  // === 富文本字段（GMP 偏差调查标准）===
  rootCause?: string            // 根本原因分析（RCA）结论
  impactAssessment?: string     // 影响评估
  affectedBatchIds?: string[]   // 受影响的其他批次
  investigations?: DeviationInvestigation[]
  capaActions?: CAPAAction[]
}

// ============= 计划基线（Plan Baseline / 版本对标）=============

export interface BaselineMilestoneSnapshot {
  id: string
  code: string
  name: string
  plannedStart: string
  plannedEnd: string
  isCriticalPath: boolean
}

/** 设立基线时冻结的项目计划快照（键与后端 _build_snapshot 一致）。 */
export interface BaselineSnapshot {
  projectPlannedStart: string
  projectPlannedEnd: string
  progress: number
  totalBudget: number
  taskCount: number
  milestoneCount: number
  milestones: BaselineMilestoneSnapshot[]
}

export interface ProjectBaseline {
  id: string
  projectId: string
  label: string
  reason: string | null
  snapshot: BaselineSnapshot
  createdBy: string | null
  createdAt: string
}
