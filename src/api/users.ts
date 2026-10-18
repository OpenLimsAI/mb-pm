// Users API
import { api } from './client'
import type { UserDTO } from './types'

export interface UsersListParams {
  role?: string
  specialtyGroup?: string
  isActive?: boolean
  keyword?: string
}

export async function listUsers(params: UsersListParams = {}): Promise<UserDTO[]> {
  const { data } = await api.get<UserDTO[]>('/users', { params })
  return data
}

// 新增 / 修改 / 删除成员已移到门户「账号管理」（与 IAM 同步），后端对应接口返回 410。
