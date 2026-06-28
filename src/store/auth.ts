// 认证 store —— 由 Casdoor 登录态派生当前用户。
import { create } from 'zustand'
import type { User } from '../types'
import { users as mockUsers } from '../mock/users'

interface AuthState {
  currentUser: User            // 保持非空，既有组件直接读 currentUser.role 不受影响
  setCurrentUser: (u: User) => void
}

export const useAuth = create<AuthState>((set) => ({
  // 兜底：未登录前用首个 mock 用户占位（App.tsx 守卫会在无 token 时跳登录，主界面不会真正渲染）。
  currentUser: mockUsers[0],
  setCurrentUser: (u) => set({ currentUser: u }),
}))
