import axios from 'axios'
import { API_BASE } from '../../api/client'

export const applicationLabels = {
  platform: '平台与登录', pm: '项目管理', kb: '知识库', 'knowledge-sources': '知识源',
  solutions: '研究报告', assistant: 'AI助手', notes: '我的笔记', models: 'AI设置',
  settings: '我的设置', mdm: '主数据管理', accounts: '账号管理', feedback: '回音壁', other: '其他',
} as const
export type FeedbackApplication = keyof typeof applicationLabels
export function applicationLabel(value?: string | null): string {
  if (!value) return '未分类'
  return Object.hasOwn(applicationLabels, value) ? applicationLabels[value as FeedbackApplication] : '其他应用'
}

export type Category = 'bug' | 'feature'
export type FeedbackStatus = 'open' | 'in_progress' | 'fixed'
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
}
export type FeedbackActivity = {
  id: string
  kind: 'comment' | 'status'
  body: string
  author_name: string
  created_at: string
  from_status?: FeedbackStatus | null
  to_status?: FeedbackStatus | null
}
export type ActivityPage = { items: FeedbackActivity[]; next_cursor: string | null; feedback?: FeedbackItem }
export const statusLabels: Record<FeedbackStatus, string> = { open: '待处理', in_progress: '处理中', fixed: '已修复' }
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
