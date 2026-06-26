// 模板会话级状态 — 把 mock/templates.ts 的静态数组包装成可变 store
//
// 演示模式策略：
//   - 启动时以 mock 数据为种子，与 localStorage 中已保存的草稿/版本合并
//   - "新建模板" 在 store 里 push 一条记录，编辑器随后能找到它
//   - 编辑器保存时调 addVersion()，旧版本保留，新版本设为 currentVersion
//   - persist 中间件让刷新页面后用户的更改不丢

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProductType, Template, TemplateNode, TemplateVersion } from '../types'
import { templates as mockTemplates } from '../mock/templates'

interface TemplatesStore {
  templates: Template[]

  /** 创建新模板。返回新 Template 对象（含初始 V1.0 版本）。 */
  createTemplate: (input: {
    name: string
    productType: ProductType
    description: string
    initialStructure: TemplateNode
    createdBy: string
  }) => Template

  /** 给指定模板追加一个新版本，并把该版本设为 currentVersion。 */
  addVersion: (templateId: string, version: Omit<TemplateVersion, 'isCurrent'>) => void

  /** 更新元数据（名称 / 描述 / 启用状态）。 */
  updateTemplate: (templateId: string, patch: Partial<Pick<Template, 'name' | 'description' | 'isActive'>>) => void

  /** 删除模板（含其全部版本）。 */
  deleteTemplate: (templateId: string) => void

  /** 重置回 mock 初始状态（清掉 localStorage 中的草稿）。 */
  reset: () => void
}

const seedTemplates = (): Template[] => mockTemplates.map((t) => ({
  ...t,
  versions: t.versions.map((v) => ({ ...v })),
}))

let _seq = 0
const nextId = (prefix: string) => {
  _seq += 1
  return `${prefix}-${Date.now().toString(36)}-${_seq}`
}

export const useTemplatesStore = create<TemplatesStore>()(
  persist(
    (set) => ({
      templates: seedTemplates(),

      createTemplate: ({ name, productType, description, initialStructure, createdBy }) => {
        const id = nextId('t')
        const now = new Date().toISOString()
        const versionId = nextId('v')
        const initialVersion: TemplateVersion = {
          id: versionId,
          templateId: id,
          versionNumber: 'V1.0',
          structureJson: initialStructure,
          changeSummary: '初始版本',
          changeSource: 'visual_edit',
          modifiedBy: createdBy,
          modifiedAt: now,
          isCurrent: true,
        }
        const tmpl: Template = {
          id,
          name,
          productType,
          currentVersion: 'V1.0',
          description,
          isActive: true,
          createdBy,
          createdAt: now,
          updatedAt: now,
          versions: [initialVersion],
        }
        set((s) => ({ templates: [tmpl, ...s.templates] }))
        return tmpl
      },

      addVersion: (templateId, version) => set((s) => ({
        templates: s.templates.map((t) => {
          if (t.id !== templateId) return t
          const oldVersions = t.versions.map((v) => ({ ...v, isCurrent: false }))
          return {
            ...t,
            currentVersion: version.versionNumber,
            updatedAt: version.modifiedAt,
            versions: [{ ...version, isCurrent: true }, ...oldVersions],
          }
        }),
      })),

      updateTemplate: (templateId, patch) => set((s) => ({
        templates: s.templates.map((t) =>
          t.id === templateId ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t,
        ),
      })),

      deleteTemplate: (templateId) => set((s) => ({
        templates: s.templates.filter((t) => t.id !== templateId),
      })),

      reset: () => set({ templates: seedTemplates() }),
    }),
    {
      name: 'cmc-pms-lite-templates',  // Lite 版独立 key
      // 内置模板增删改时必须 bump version，否则用户的 localStorage 会盖住新 mock
      // v2 (2026-05-09): 新增 DMP v3.6「原液工艺开发」标准模板（33 任务）
      // v3 (2026-05-09): 删除旧的「单抗 IND」「双特异性抗体」模板，仅保留 DMP
      // v4 (2026-05-10): 修复 DMP 模板 defaultDuration 单位（周→天）
      version: 4,
    },
  ),
)

/** 便捷 selector：快速取一个模板。 */
export const useTemplate = (id: string | undefined): Template | undefined =>
  useTemplatesStore((s) => (id ? s.templates.find((t) => t.id === id) : undefined))
