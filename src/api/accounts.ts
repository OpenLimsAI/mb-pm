// 门户「账号管理」接口（后端 backend/app/api/v1/accounts.py）：修改直接写入 IAM。
// 走门户会话；与 PM 的 api 实例分开，401 不触发 PM 全局退出。
import axios from 'axios'
import { API_BASE, camelize, snakeize } from './client'
import type { SpecialtyGroup } from '../types'
/** 身份：系统管理员 / 项目负责人 / 员工（对应 IAM 角色见 backend/app/services/accounts.py）。 */
export type Identity = 'admin' | 'lead' | 'staff'
export type ActorTier = 'admin' | 'lead'

export interface PMMember {
  id: string
  username: string
  active: boolean
  bound: boolean
  specialtyGroup: SpecialtyGroup | null
  weeklyHours: number
}

export interface Account {
  id: string
  username: string
  displayName: string
  email: string
  createdAt: string
  enabled: boolean
  mustChangePassword: boolean
  orgAdmin: boolean
  identity: Identity
  /** 知识库默认对所有人开放（编辑）；false 时在「需要处理」里修复。 */
  kbEnabled: boolean
  pmRoles: string[]
  otherRoles: string[]
  /** 项目管理成员档案；为空表示还没进过项目管理（首次进入时自动建）。 */
  pmMember: PMMember | null
  isSelf: boolean
}

export type IssueKind = 'iam_password_flag' | 'kb_missing' | 'pm_member_inactive' | 'pm_member_conflict' | 'default_account' | 'pm_only_member'

export interface AccountIssue {
  kind: IssueKind
  accountId: string | null
  memberId: string | null
  username: string
  displayName: string
  message: string
}

export interface AccountCreateInput {
  username: string
  displayName: string
  password: string
  email?: string
  identity: Identity
  specialtyGroup: SpecialtyGroup | null
  weeklyHours: number
}

export interface AccountUpdateInput {
  displayName?: string
  email?: string
  enabled?: boolean
  identity?: Identity
  /** 空字符串表示清空专业组。 */
  specialtyGroup?: SpecialtyGroup | ''
  weeklyHours?: number
}

const accountsApi = axios.create({ baseURL: `${API_BASE}/portal/accounts`, withCredentials: true, timeout: 20000 })
accountsApi.interceptors.request.use((config) => {
  if (config.data && typeof config.data === 'object') config.data = snakeize(config.data)
  return config
})

/** roles：IAM 中已建立的相关角色（未建立的身份在界面上禁用）；actor：当前操作人的身份。 */
export async function fetchAccounts(): Promise<{ accounts: Account[]; issues: AccountIssue[]; roles: string[]; actor: ActorTier }> {
  const { data } = await accountsApi.get('')
  return camelize(data)
}

export const createAccount = (input: AccountCreateInput) => accountsApi.post('', input)
export const updateAccount = (id: string, input: AccountUpdateInput) => accountsApi.patch(`/${encodeURIComponent(id)}`, input)
export const renameAccount = (id: string, username: string) => accountsApi.post(`/${encodeURIComponent(id)}/username`, { username })
export const resetAccountPassword = (id: string, password: string) => accountsApi.post(`/${encodeURIComponent(id)}/password`, { password })
export const repairAccount = (id: string) => accountsApi.post(`/${encodeURIComponent(id)}/repair`)
export const deleteAccount = (id: string) => accountsApi.delete(`/${encodeURIComponent(id)}`)
