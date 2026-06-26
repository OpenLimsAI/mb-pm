// 把前端 Lite 的真实数据导出为 backend/app/seed/seed.json，
// 供后端种子加载，确保「后端数据 == 前端展示」完全一致。
//
// 用法：npx tsx scripts/dump-seed.mjs

import { writeFileSync } from 'node:fs'
import { projects } from '../src/mock/projects.ts'
import { subProjects, tasks, taskDependencies } from '../src/mock/tasks.ts'
import { users } from '../src/mock/users.ts'
import { templates } from '../src/mock/templates.ts'
import { projectFinances } from '../src/mock/finance.ts'

const seed = {
  users,
  templates,
  projects: projects.map((p) => ({ ...p, memberIds: p.memberIds ?? [] })),
  subProjects,
  tasks,
  taskDependencies,
  projectFinances,
}

const out = new URL('../backend/app/seed/seed.json', import.meta.url)
writeFileSync(out, JSON.stringify(seed, null, 2), 'utf-8')

console.log('✔ wrote seed.json', {
  users: users.length,
  templates: templates.length,
  projects: projects.length,
  subProjects: subProjects.length,
  tasks: tasks.length,
  deps: taskDependencies.length,
  finances: projectFinances.length,
})
