// 运行时数据状态 —— 数据源模式 + 版本号（驱动读 mock 运行时数组的组件重渲染）。
//
// 设计：mock/* 数组是「运行时唯一真相」。API 模式下，bootstrap 用后端数据
// 覆盖这些数组；任何 mutation 后调用 bump() 让订阅了 version 的组件刷新。

import { create } from 'zustand'

export type DataMode = 'loading' | 'api' | 'mock'

interface DataState {
  /** 数据变更版本号 —— 组件把它放进 useMemo 依赖即可在数据更新后刷新 */
  version: number
  /** 当前数据源：api=后端持久化 / mock=离线只读回退 */
  mode: DataMode
  /** bootstrap 是否完成（用于首屏加载门） */
  ready: boolean
  /** 非致命错误提示（如后端不可用回退） */
  notice: string | null
  bump: () => void
  setMode: (m: DataMode) => void
  setReady: (r: boolean) => void
  setNotice: (n: string | null) => void
}

export const useDataStore = create<DataState>((set) => ({
  version: 0,
  mode: 'loading',
  ready: false,
  notice: null,
  bump: () => set((s) => ({ version: s.version + 1 })),
  setMode: (mode) => set({ mode }),
  setReady: (ready) => set({ ready }),
  setNotice: (notice) => set({ notice }),
}))
