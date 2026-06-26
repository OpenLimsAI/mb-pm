// 已创建项目 store — Lite (CTO) 版
//
// 设计：mock 数组（mock/projects.ts、mock/tasks.ts）是「运行时唯一真相」，
// 内置示例项目 p1/p2/p3 与用户新建项目都活在同一批数组里，所有页面
// （首页 / 项目列表 / 项目详情及其 WBS·甘特·里程碑子组件）都直接读它们，
// 无需改动既有取数逻辑。
//
// 本 store 只承担两件事：
//   1. 持久化用户新建的项目（localStorage），刷新后不丢；
//   2. 启动时把持久化的项目重新「灌」回 mock 数组（hydrateCreatedIntoMock）。
//
// createProject() 会同时：push 进 mock 数组（即时可见）+ 写入 store（持久化）。

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Project, SubProject, Task, TaskDependency } from '../types'
import { projects as mockProjects } from '../mock/projects'
import { subProjects as mockSubs, tasks as mockTasks, taskDependencies as mockDeps } from '../mock/tasks'
import { projectFinances, type ProjectFinance } from '../mock/finance'

export interface ProjectBundle {
  project: Project
  subProjects: SubProject[]
  tasks: Task[]
  dependencies: TaskDependency[]
  /** 新建项目的财务记录（让其纳入首页组合预算聚合） */
  finance?: ProjectFinance
}

/** 把一个 bundle 灌进 mock 运行时数组（按 id 去重，幂等）。 */
function pushBundleIntoMock(b: ProjectBundle) {
  if (!mockProjects.some((p) => p.id === b.project.id)) mockProjects.push(b.project)
  for (const s of b.subProjects) if (!mockSubs.some((x) => x.id === s.id)) mockSubs.push(s)
  for (const t of b.tasks) if (!mockTasks.some((x) => x.id === t.id)) mockTasks.push(t)
  for (const d of b.dependencies) if (!mockDeps.some((x) => x.id === d.id)) mockDeps.push(d)
  if (b.finance && !projectFinances.some((f) => f.projectId === b.finance!.projectId)) {
    projectFinances.push(b.finance)
  }
}

interface ProjectsStore {
  /** 用户新建的项目（不含内置示例 p1/p2/p3） */
  created: ProjectBundle[]
  /** 每次新建自增，供页面需要时强制刷新 */
  version: number
  createProject: (bundle: ProjectBundle) => void
  /** 删除一个新建项目（同时从 mock 数组移除） */
  removeProject: (projectId: string) => void
}

export const useProjectsStore = create<ProjectsStore>()(
  persist(
    (set, get) => ({
      created: [],
      version: 0,

      createProject: (bundle) => {
        // 防御 id 碰撞（如重复提交）：已存在则忽略，避免 store 与 mock 数组不一致。
        if (get().created.some((b) => b.project.id === bundle.project.id)) return
        pushBundleIntoMock(bundle)
        set({ created: [...get().created, bundle], version: get().version + 1 })
      },

      removeProject: (projectId) => {
        // 从 mock 数组移除
        const rm = <T>(arr: T[], pred: (x: T) => boolean) => {
          for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) arr.splice(i, 1)
        }
        const bundle = get().created.find((b) => b.project.id === projectId)
        if (bundle) {
          rm(mockProjects, (p) => p.id === projectId)
          const subIds = new Set(bundle.subProjects.map((s) => s.id))
          rm(mockSubs, (s) => subIds.has(s.id))
          const taskIds = new Set(bundle.tasks.map((t) => t.id))
          rm(mockTasks, (t) => taskIds.has(t.id))
          rm(mockDeps, (d) => taskIds.has(d.predecessorId) || taskIds.has(d.successorId))
          rm(projectFinances, (f) => f.projectId === projectId)
        }
        set({ created: get().created.filter((b) => b.project.id !== projectId), version: get().version + 1 })
      },
    }),
    { name: 'cmc-pms-cto-projects', version: 1 },
  ),
)

/**
 * 启动时调用一次：把持久化的新建项目灌回 mock 运行时数组。
 * 在 main.tsx 渲染 <App/> 之前调用，确保首屏即可见。
 */
export function hydrateCreatedIntoMock() {
  for (const b of useProjectsStore.getState().created) pushBundleIntoMock(b)
}
