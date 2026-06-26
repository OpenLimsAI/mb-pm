// 认证 store — Lite (CTO) 版
//
// CTO 版没有登录页：直接以「郭主任（CMC 负责人 / cmc_lead）」身份进入。
// 该角色在权限矩阵里拥有全局组合视图（getScope → isAll）+ 模板维护权限，
// 正好对应「CTO 纵览所有在研项目」的诉求。其余既有组件仍可正常读取 currentUser。

import { create } from 'zustand'
import type { User } from '../types'
import { users } from '../mock/users'

// u2 = 郭主任 / cmc_lead；兜底取首个用户。
const ctoUser: User = users.find((u) => u.id === 'u2') ?? users[0]

interface AuthState {
  currentUser: User
}

export const useAuth = create<AuthState>(() => ({
  currentUser: ctoUser,
}))
