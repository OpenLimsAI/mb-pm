import axios from 'axios'
import { API_BASE } from '../../api/client'

export const applicationLabels = {
  platform: '平台与登录', pm: '项目管理', kb: '知识库', 'knowledge-sources': '知识源', 'data-backup': '数据备份',
  solutions: '研究报告', assistant: 'AI助手', notes: '我的笔记', models: 'AI设置',
  settings: '我的设置', mdm: '主数据管理', accounts: '账号管理', feedback: '回音壁', other: '其他',
} as const
export type FeedbackApplication = keyof typeof applicationLabels
export function applicationLabel(value?: string | null): string {
  if (!value) return '未分类'
  return Object.hasOwn(applicationLabels, value) ? applicationLabels[value as FeedbackApplication] : '其他应用'
}

export type Category = 'bug' | 'feature'
export type FeedbackStatus = 'open' | 'in_progress' | 'ready' | 'released' | 'fixed'
export type FeedbackSource = { application?: FeedbackApplication; path?: string; browser?: string; captured_at?: string }
export type FeedbackPriority = 'p0' | 'p1' | 'p2' | 'p3'
export const priorityLabels: Record<FeedbackPriority, string> = { p0: 'P0 紧急', p1: 'P1 高', p2: 'P2 普通', p3: 'P3 低' }
export type FeedbackItem = {
  id: string
  category: Category
  application?: string | null
  description: string
  status: FeedbackStatus
  author_name: string
  created_at: string
  images: string[]
  can_delete: boolean
  is_mine?: boolean
  reply_count?: number
  last_activity_at?: string
  issue_number?: number | null
  number?: string | null
  permalink?: string
  source_context?: FeedbackSource | null
  revision?: number
  is_overdue?: boolean
  can_remind?: boolean
  workflow_version?: 1 | 2
  assignee_id?: string | null
  assignee_name?: string | null
  priority?: FeedbackPriority
  due_at?: string | null
  resolution?: string
  verification_steps?: string
  release_version?: string
  can_edit?: boolean
  can_manage?: boolean
  can_assign?: boolean
  can_claim?: boolean
  can_unclaim?: boolean
  can_reopen?: boolean
  can_verify?: boolean
  vote_count?: number
  has_voted?: boolean
  is_following?: boolean
  unread_count?: number
  steps_to_reproduce?: string
  expected_result?: string
  actual_result?: string
  problem_to_solve?: string
  expected_benefit?: string
}
export type FeedbackActivity = {
  id: string
  kind: 'comment' | 'status' | 'edit' | 'management' | 'verification' | 'release'
  body: string
  author_name: string
  created_at: string
  from_status?: FeedbackStatus | null
  to_status?: FeedbackStatus | null
  images?: string[]
  details?: Record<string, unknown>
}
export type ActivityPage = { items: FeedbackActivity[]; next_cursor: string | null; feedback?: FeedbackItem }
export const statusLabels: Record<FeedbackStatus, string> = { open: '待处理', in_progress: '处理中', ready: '待发布', released: '已上线待验证', fixed: '已修复' }
export const feedbackClient = axios.create({ baseURL: `${API_BASE}/feedback`, withCredentials: true, timeout: 30000 })
export function imageUrl(id: string) { return id.startsWith('blob:') ? id : `${API_BASE}/feedback/images/${id}` }
export function activityTime(value: string) {
  const normalized = value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z'
  const time = new Date(normalized).valueOf()
  const fraction = normalized.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] || ''
  const remainder = Number(fraction.padEnd(6, '0').slice(3, 6)) / 1000
  return Number.isNaN(time) ? 0 : time + remainder
}
export function formatDate(value: string) {
  const time = activityTime(value)
  return time ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '时间未知'
}
export function mergeActivities(current: FeedbackActivity[], incoming: FeedbackActivity[]) {
  return Array.from(new Map([...current, ...incoming].map(item => [item.id, item])).values())
    .sort((a, b) => activityTime(a.created_at) - activityTime(b.created_at) || a.id.localeCompare(b.id))
}

export type FeedbackNotification = { id: string; feedback_id: string; number: string | null; permalink: string; kind: string; body: string; created_at: string; read_at: string | null }
export type FeedbackNotifications = { items: FeedbackNotification[]; unread_count: number }
export type FeedbackWorkbench = { items: FeedbackItem[]; metrics: { open: number; in_progress: number; ready: number; released: number; fixed: number; overdue: number; unassigned: number; mine: number; average_resolution_hours: number | null; average_first_response_hours?: number | null; unanswered?: number; first_response_count?: number; resolution_count?: number }; by_application?: { application: string | null; total: number; open: number; pending: number; overdue: number; average_first_response_hours: number | null; first_response_count: number; average_resolution_hours: number | null; resolution_count: number }[] }
export type FeedbackStructure = { steps_to_reproduce: string; expected_result: string; actual_result: string; problem_to_solve: string; expected_benefit: string }
export const emptyStructure: FeedbackStructure = { steps_to_reproduce: '', expected_result: '', actual_result: '', problem_to_solve: '', expected_benefit: '' }
export const structureLabels: Record<keyof FeedbackStructure, string> = { steps_to_reproduce: '复现步骤', expected_result: '期望结果', actual_result: '实际结果', problem_to_solve: '希望解决的问题', expected_benefit: '预期收益' }
export function structureKeys(category: Category): (keyof FeedbackStructure)[] { return category === 'bug' ? ['steps_to_reproduce', 'expected_result', 'actual_result'] : ['problem_to_solve', 'expected_benefit'] }
export function issueLabel(item: FeedbackItem) { return item.number || (item.issue_number ? `FB-${String(item.issue_number).padStart(4, '0')}` : '历史反馈') }
export function issuePath(item: FeedbackItem) { return `/feedback?feedback=${encodeURIComponent(item.id)}` }
