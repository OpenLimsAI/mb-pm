// 认证 store — Lite (CTO) 版
//
// IAM 启用后从会话加载真实身份；原 CTO 演示身份仅用于显式演示模式。
// 初始化期间由 App 的认证状态阻止业务页面渲染。

import { create } from 'zustand'
import type { User } from '../types'
import { users } from '../mock/users'

// u2 = 郭主任 / cmc_lead；兜底取首个用户。
const ctoUser: User = users.find((u) => u.id === 'u2') ?? users[0]

interface AuthState {
  currentUser: User
  iamEnabled: boolean
  status: 'loading' | 'ready' | 'anonymous' | 'error'
  error: string
}

export const useAuth = create<AuthState>(() => ({
  currentUser: ctoUser,
  iamEnabled: false,
  status: 'loading',
  error: '',
}))

window.addEventListener('pms-lite:unauthorized', () => {
  if (useAuth.getState().iamEnabled) useAuth.setState({ status: 'anonymous' })
})
