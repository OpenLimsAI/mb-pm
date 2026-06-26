// Users API
import { api } from './client'
import type { UserDTO } from './types'
import type { Role, SpecialtyGroup } from '../types'

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

export interface UserCreateRequest {
  username: string
  displayName: string
  email: string
  role: Role
  specialtyGroup?: SpecialtyGroup | null
  weeklyAvailableHours?: number
  isActive?: boolean
  avatarColor?: string | null
}

export async function createUser(payload: UserCreateRequest): Promise<UserDTO> {
  const { data } = await api.post<UserDTO>('/users', payload)
  return data
}

export interface UserUpdateRequest {
  displayName?: string
  email?: string
  role?: Role
  specialtyGroup?: SpecialtyGroup | null
  weeklyAvailableHours?: number
  isActive?: boolean
  avatarColor?: string | null
}

export async function updateUser(id: string, payload: UserUpdateRequest): Promise<UserDTO> {
  const { data } = await api.patch<UserDTO>(`/users/${id}`, payload)
  return data
}

export async function deleteUser(id: string): Promise<void> {
  await api.delete(`/users/${id}`)
}
