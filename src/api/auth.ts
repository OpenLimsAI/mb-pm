// 认证 API
import { api } from './client'
import type { LoginRequest, TokenResponse, UserDTO } from './types'

export async function login(payload: LoginRequest): Promise<TokenResponse> {
  const { data } = await api.post<TokenResponse>('/auth/login', payload)
  return data
}

export async function fetchMe(): Promise<UserDTO> {
  const { data } = await api.get<UserDTO>('/auth/me')
  return data
}

export interface IAMConfig {
  enabled: boolean
  loginUrl: string
  signupUrl: string
  accountUrl: string
}
export async function fetchIAMConfig(): Promise<IAMConfig> {
  return (await api.get<IAMConfig>('/auth/config')).data
}
